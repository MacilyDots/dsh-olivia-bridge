/* Probe injected into index.html.
 *
 * The package IS loaded and injected code runs. This probe answers "where is
 * the front-end stuck and what does the UI actually look like":
 *   1. log every XHR / fetch the front-end makes (original URL + rewritten);
 *   2. capture global JS errors and unhandled promise rejections;
 *   3. rewrite /toy/* requests to the local bridge;
 *   4. report UI state every 8s: route, appMode, mail nodes, write-button count;
 *   5. poll a local helper (8792) for out-of-band commands, because the bridge
 *      is a DSH plugin and changing it would restart DSH.
 *
 * Reports go out as GET + query string so the bridge log records them without
 * needing a DSH restart.
 *
 * IMPORTANT: keep this file pure ASCII. It gets injected into index.html; a
 * mis-placed <meta charset> once made the browser mis-decode the whole page and
 * the Chinese comments here broke the script.
 */
(function () {
  // Idempotency marker. patch-feapp.ps1 greps index.html for this exact name
  // before injecting, so the probe must never be injected twice.
  var oliviaBridgeProbe = 1;
  var LOCAL = 'http://127.0.0.1:8791';
  var HELPER = 'http://127.0.0.1:8792';
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  function report(path, data) {
    if (!nativeFetch) return;
    try {
      var qs = encodeURIComponent(JSON.stringify(data)).slice(0, 900);
      nativeFetch(LOCAL + path + '?d=' + qs).catch(function () {});
    } catch (e) {}
  }

  function rewrite(url) {
    if (typeof url !== 'string' || url === '') return url;
    if (url.indexOf('/toy/') === 0) return LOCAL + url;
    var m = url.match(/^https?:\/\/[^/]*(miyoushe\.com|mihoyo\.com)(\/toy\/.*)$/);
    if (m) return LOCAL + m[2];
    return url;
  }

  function getRouter() {
    try {
      var el = document.getElementById('app');
      var app = el && el.__vue_app__;
      var gp = app && app.config && app.config.globalProperties;
      return (gp && gp.$router) || null;
    } catch (e) { return null; }
  }

  // Consumed by the front-end sidebar patch (patch 8), which turns the two
  // invisible tour anchor divs into real navigation buttons. This file is
  // injected into index.html, so it runs before the app bundle and the global
  // is already there when those vnodes are created.
  window.__oliviaNav = function (name) {
    var r = getRouter();
    if (r) r.replace({ name: name });
  };

  // Dump the UI structure: where the tour anchors really are (the sidebar in
  // the App template is `w-0 ... pointer-events-none`, so it may well be an
  // invisible tour anchor rather than a clickable entry), plus every visible
  // fixed-position element, which is what a real sidebar / floating entry
  // would be.
  function reportDom() {
    var anchors = [];
    var ids = ['tour-studio', 'tour-collection', 'tour-profile', 'tour-mode-select', 'tour-song-list'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (!el) { anchors.push(ids[i] + '=absent'); continue; }
      var r = el.getBoundingClientRect();
      var cs = window.getComputedStyle(el);
      anchors.push(ids[i] + '=' + Math.round(r.width) + 'x' + Math.round(r.height) +
        '@' + Math.round(r.left) + ',' + Math.round(r.top) +
        ' pe=' + cs.pointerEvents + ' vis=' + cs.visibility);
    }
    var fixed = [];
    try {
      var all = document.querySelectorAll('body *');
      for (var j = 0; j < all.length && fixed.length < 10; j++) {
        var fe = all[j];
        var fcs = window.getComputedStyle(fe);
        if (fcs.position !== 'fixed') continue;
        var fr = fe.getBoundingClientRect();
        if (fr.width < 6 || fr.height < 6) continue;
        fixed.push((fe.id || fe.tagName) + '|' + String(fe.className).slice(0, 34) +
          '|' + Math.round(fr.left) + ',' + Math.round(fr.top) + ' ' + Math.round(fr.width) + 'x' + Math.round(fr.height));
      }
    } catch (e) {}
    report('/olivia/dom-anchors', { anchors: anchors.join(' ') });
    report('/olivia/dom-fixed', { n: fixed.length, fixed: fixed.join(' ~ ') });
  }

  try {
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      var target = rewrite(url);
      report('/olivia/xhr', {
        m: String(method),
        u: String(url).slice(0, 300),
        to: target !== url ? String(target).slice(0, 300) : undefined,
      });
      args[1] = target;
      return open.apply(this, args);
    };
  } catch (e) {}

  try {
    if (window.fetch) {
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : input && input.url;
        var target = rewrite(url);
        report('/olivia/fetch', {
          u: String(url).slice(0, 300),
          to: target !== url ? String(target).slice(0, 300) : undefined,
        });
        if (typeof input === 'string') input = target;
        return nativeFetch(input, init);
      };
    }
  } catch (e) {}

  // ---- native bridge recorders ----
  // The song catalog does NOT come over HTTP: offlineCatalog.load() calls
  // Xm() -> We({action:"getOfflineSongList"}), and We wraps
  // window.cefViewQuery({request, onSuccess, onFailure}) with NO timeout --
  // if the native side never answers, that promise stays pending forever
  // (which is what we saw: neither catalog-loaded nor catalog-failed showed up).
  //
  // Two gotchas learned the hard way:
  //   1. window.cefViewQuery may not exist yet when this script runs, and it
  //      may be installed as a non-writable property. Install it lazily with a
  //      poll, and fall back to defineProperty.
  //   2. Report the installation outcome, otherwise a silent failure looks
  //      exactly like "the native side was never called at all".
  function wrapCef() {
    var current = window.cefViewQuery;
    if (typeof current !== 'function') return false;
    if (current.__oliviaWrapped) return true;
    function wrapped(opts) {
      var req = opts && opts.request;
      var action = '';
      try { action = String(JSON.parse(req).action || ''); } catch (e) {}
      var started = Date.now();
      var patched = {};
      for (var k in opts) patched[k] = opts[k];
      patched.onSuccess = function (res) {
        try { report('/olivia/native-ok', { a: action, ms: Date.now() - started, r: String(res).slice(0, 240) }); } catch (e) {}
        if (opts.onSuccess) return opts.onSuccess.apply(this, arguments);
      };
      patched.onFailure = function (code, msg) {
        try { report('/olivia/native-fail', { a: action, ms: Date.now() - started, c: String(code), m: String(msg).slice(0, 160) }); } catch (e) {}
        if (opts.onFailure) return opts.onFailure.apply(this, arguments);
      };
      try { report('/olivia/native-req', { a: action, req: String(req).slice(0, 160) }); } catch (e) {}
      return current.call(window, patched);
    }
    wrapped.__oliviaWrapped = true;
    try {
      window.cefViewQuery = wrapped;
      if (window.cefViewQuery === wrapped) return true;
    } catch (e) {}
    try {
      Object.defineProperty(window, 'cefViewQuery', { value: wrapped, writable: true, configurable: true });
      return window.cefViewQuery === wrapped;
    } catch (e) {}
    return false;
  }

  var cefTries = 0;
  (function installCef() {
    if (wrapCef()) {
      report('/olivia/hook-installed', { hook: 'cefViewQuery', tries: cefTries });
      return;
    }
    if (cefTries++ < 60) {
      setTimeout(installCef, 250);
      return;
    }
    report('/olivia/hook-installed', { hook: 'cefViewQuery', ok: false, type: typeof window.cefViewQuery });
  })();

  // ToyPianistClient.invoke is the front-end -> native event channel
  // (toggleLetterEntry, letterSend, ...). Recording it shows what the
  // front-end pushed even when the native side does not answer.
  try {
    var tpc = window.ToyPianistClient;
    if (tpc && typeof tpc.invoke === 'function' && !tpc.__oliviaWrapped) {
      var origInvoke = tpc.invoke.bind(tpc);
      tpc.invoke = function (action, data) {
        try { report('/olivia/native-invoke', { a: String(action), d: String(JSON.stringify(data || {})).slice(0, 120) }); } catch (e) {}
        return origInvoke(action, data);
      };
      tpc.__oliviaWrapped = true;
      report('/olivia/hook-installed', { hook: 'ToyPianistClient.invoke' });
    }
  } catch (e) {}

  try {
    window.addEventListener('error', function (e) {
      report('/olivia/js-error', {
        msg: String(e.message).slice(0, 400),
        src: String(e.filename || '').slice(0, 200),
        line: e.lineno,
      });
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason;
      report('/olivia/js-reject', { reason: String((r && r.message) || r).slice(0, 400) });
    });
  } catch (e) {}

  report('/olivia/probe-from-game', {
    at: Date.now(),
    ready: document.readyState,
    charset: document.characterSet,
    hasToyClient: typeof window.ToyPianistClient,
    hasCefQuery: typeof window.cefViewQuery,
  });

  function snapshot(tag) {
    var info = { tag: tag };
    try { info.mode = String(localStorage.getItem('appMode') || ''); } catch (e) { info.mode = 'n/a'; }
    try { info.hash = String(location.hash || '').slice(0, 60); } catch (e) {}
    try {
      var r = getRouter();
      var cur = r && r.currentRoute && r.currentRoute.value;
      info.route = cur ? String(cur.path) + '|' + String(cur.name) : 'n/a';
    } catch (e) { info.route = 'err'; }
    try {
      // .mail-footer-action-button is the "write a letter" button inside
      // MailBoxSidebar; its presence is the direct evidence patch 7 worked.
      info.mailNodes = document.querySelectorAll('[class*="mail-"]').length;
      info.writeBtns = document.querySelectorAll('.mail-footer-action-button').length;
      info.text = String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 120);
    } catch (e) {}
    report('/olivia/ui-state', info);
  }

  setTimeout(function () { snapshot('t3'); }, 3000);
  setInterval(function () { snapshot('tick'); }, 8000);

  // ---- out-of-band command channel (helper on 8792) ----
  var autoNavDone = false;

  function execCommand(cmd) {
    if (!cmd || !cmd.type) return;
    if (cmd.type === 'nav') {
      var r = getRouter();
      var name = cmd.name || 'collection';
      if (r) r.replace({ name: name });
      report('/olivia/nav-exec', { name: String(name), ok: !!r });
      setTimeout(function () { snapshot('after-nav'); }, 1200);
    } else if (cmd.type === 'click') {
      var el = null;
      try { el = document.querySelector(cmd.sel || ''); } catch (e) {}
      if (el) el.click();
      report('/olivia/click-exec', { sel: String(cmd.sel || ''), ok: !!el });
      setTimeout(function () { snapshot('after-click'); }, 1200);
    } else if (cmd.type === 'dom') {
      reportDom();
    } else if (cmd.type === 'ping') {
      report('/olivia/ping', { ok: true, route: String(location.hash || '') });
    }
  }

  function pollCommand() {
    if (!nativeFetch) return;
    nativeFetch(HELPER + '/next', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.auto && !autoNavDone) {
          autoNavDone = true;
          execCommand({ type: 'nav', name: j.auto });
        }
        if (j && j.cmd) execCommand(j.cmd);
      })
      .catch(function () {});
  }
  setTimeout(pollCommand, 2000);
  setInterval(pollCommand, 4000);
})();
