/* dsh-olivia-bridge — 宿主半边。
 *
 * 在回环地址上起一个独立 HTTP 服务，冒充《BSide: Olivia Lin》客户端的
 * 后端（/toy/letter/* 契约），把每封来信投进一个 DSH agent 会话，再把
 * 她写的回信写回信件存储。
 *
 * 为什么不用 ctx.webServer：那个路由表服务的是 DSH 自己的浏览器 GUI
 * （Electron 端根本不走它）。游戏客户端需要一个稳定的本地端口，所以这里
 * 自己拿 node:http 监听，与宿主 GUI 完全解耦。
 */
import http from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentBridge } from "./agent-bridge.js";
import { LINLI_SYSTEM_PROMPT, wrapFirstLetter } from "./persona.js";
import { AUDIT, LetterStore, REPLY_TYPE, STATUS, dataDir } from "./store.js";

export const name = "dsh-olivia-bridge";

const DEFAULTS = {
  port: 8791,
  host: "127.0.0.1",
  presetId: "olivia",
  provider: "",
  model: "",
  permissionPreset: "",
  llmFallback: true,
  // 本地自用桥，不是官方服务器：不设每日额度。前端那句「今天还可寄 N 封信」
  // 也已被补丁 9 换掉，所以这里只要保证 sentToday 永远撞不到上限即可。
  maxDailyLetters: 1000000,
  useAgent: true,
};

const MAX_BODY_BYTES = 1024 * 1024;

/* ── 小工具 ─────────────────────────────────────────────────────── */

function logLine(message) {
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "bridge.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    /* 日志永远不该让插件挂掉 */
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve("");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", typeof origin === "string" && origin !== "" ? origin : "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  const requested = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", typeof requested === "string" && requested !== "" ? requested : "content-type,x-token,x-uid,x-platform,x-bw");
  res.setHeader("Access-Control-Max-Age", "600");
}

/** 客户端约定：所有响应都是 { code, message, data }。 */
function sendJson(req, res, payload, status = 200) {
  applyCors(req, res);
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function sendOk(req, res, data) {
  sendJson(req, res, { code: 0, message: "", data: data ?? {} });
}

function sendErr(req, res, code, message, data) {
  sendJson(req, res, { code, message, data: data ?? {} });
}

/* ── 插件主体 ───────────────────────────────────────────────────── */

export function apply(ctx, config) {
  // cordis 把 patch 行的 config 作为第二个参数传入；两种来源都兼容一下。
  const cfg = { ...DEFAULTS, ...(config || ctx?.config || {}) };
  const store = new LetterStore();
  const bridge = new AgentBridge(ctx, {
    presetId: cfg.presetId,
    provider: cfg.provider,
    model: cfg.model,
    permissionPreset: cfg.permissionPreset,
    llmFallback: cfg.llmFallback,
    workspacePath: cfg.workspacePath,
    systemPrompt: LINLI_SYSTEM_PROMPT,
    wrapFirstLetter,
    onLog: logLine,
  });

  const inFlight = new Set();

  /** 生成回信：投给 agent 会话，写回存储。绝不抛出到请求路径。 */
  async function replyTo(letterId) {
    if (inFlight.has(letterId)) return;
    inFlight.add(letterId);
    try {
      const letter = store.get(letterId);
      if (!letter) return;
      store.markProcessing(letterId);
      logLine(`letter ${letterId} -> agent (${letter.content.length} chars)`);
      const started = Date.now();
      const reply = await bridge.ask(letter.content);

      store.markReplied(letterId, reply, REPLY_TYPE.TEXT);
      logLine(`letter ${letterId} <- reply (${reply.length} chars, ${Date.now() - started}ms)`);
    } catch (error) {
      const message = String(error?.message ?? error);
      store.markFailed(letterId, message);
      logLine(`letter ${letterId} failed: ${message}`);
    } finally {
      inFlight.delete(letterId);
    }
  }

  /* 路由表：path 相对于 baseURL（客户端 baseURL 已含 /toy） */

  async function handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = (req.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      applyCors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    logLine(`${method} ${path}${url.search}`);

    // ── 自带诊断端点（非游戏契约，只给排错用）──────────────────
    if (path === "/olivia/diag") {
      const presets = (typeof ctx.get === "function" ? ctx.get("agentPresets") : null) ?? ctx.agentPresets ?? null;
      let presetList = null;
      try {
        presetList =
          (typeof presets?.list === "function" && presets.list()) ||
          (typeof presets?.all === "function" && presets.all()) ||
          Object.keys(presets ?? {}).slice(0, 20);
      } catch (error) {
        presetList = `error: ${String(error?.message ?? error)}`;
      }
      sendOk(req, res, {
        configuredPresetId: cfg.presetId,
        presetService: Boolean(presets),
        presetList,
        ...bridge.diagnose(),
      });
      return;
    }

    // ── 让 agent 真的跑一轮（排错用）────────────────────────────
    if (path === "/olivia/agent-test" && method === "POST") {
      try {
        const result = await bridge.probe();
        sendOk(req, res, result);
      } catch (error) {
        sendErr(req, res, 500, String(error?.message ?? error), bridge.diagnose());
      }
      return;
    }

    // ── 重试某封失败的信（排错用）──────────────────────────────
    if (path === "/olivia/retry" && method === "POST") {
      const body = parseJson(await readBody(req));
      const id = String(body.letterId ?? body.letter_id ?? "");
      const letter = store.reset(id);
      if (!letter) {
        sendErr(req, res, 404, "letter not found");
        return;
      }
      replyTo(id);
      sendOk(req, res, { ok: true, letterId: id });
      return;
    }

    // ── 登录与用户档案 ──────────────────────────────────────────
    // 客户端启动时若本地已有 uid 就先打 getUserInfo，否则走 signIn；
    // 两者都必须给 status >= 2，否则会被打回登录页。
    if (path === "/signIn" || path === "/toy/signIn") {
      const body = parseJson(await readBody(req));
      if (body.username) store.rememberNickname(body.username);
      sendOk(req, res, store.userPayload());
      return;
    }

    if (path === "/getUserInfo" || path === "/toy/getUserInfo") {
      sendOk(req, res, store.userPayload());
      return;
    }

    if (path === "/editProfile" || path === "/toy/editProfile") {
      const body = parseJson(await readBody(req));
      if (body.nickname) store.rememberNickname(body.nickname);
      sendOk(req, res, { ...body });
      return;
    }

    if (path === "/getPreferenceSurvey" || path === "/toy/getPreferenceSurvey") {
      sendOk(req, res, { questions: [] });
      return;
    }

    if (path === "/submitPreferenceSurvey" || path === "/toy/submitPreferenceSurvey") {
      sendOk(req, res, {});
      return;
    }

    if (path === "/getMusicTypeInfo" || path === "/toy/getMusicTypeInfo") {
      // 客户端无条件 .map() 这个数组，给别的形状会直接崩。
      sendOk(req, res, { performanceModes: [] });
      return;
    }

    if (["/login", "/signout", "/toy/login", "/toy/signout"].includes(path)) {
      sendOk(req, res, {});
      return;
    }

    // ── 音乐 / 歌单 / MIDI：整体降级成空列表，界面空着但不报错 ──
    const emptyListPaths = [
      "/searchPlaylist",
      "/searchUserSongs",
      "/midi/listJobs",
      "/midi/batchGetResult",
      "/getSongStats",
    ];
    if (emptyListPaths.some((p) => path === p || path === `/toy${p}`)) {
      sendOk(req, res, { list: [], results: [], hasMore: false, nextCursor: 0, total: 0 });
      return;
    }

    // dispatch：客户端用它拿加密配置；空配置即可让前端继续走。
    if (path.includes("dispatch")) {
      sendOk(req, res, { enc_conf: "", encConf: "", conf: "", features: {}, config: {}, flags: {} });
      return;
    }

    // ── 信件契约 ────────────────────────────────────────────────
    const letterPath = path.startsWith("/toy/") ? path.slice(4) : path;

    if (letterPath === "/letter/send" && method === "POST") {
      const body = parseJson(await readBody(req));
      const content = String(body.content ?? "").trim();
      if (!content) {
        sendErr(req, res, 400, "empty content");
        return;
      }
      const sentToday = store.sentToday();
      if (sentToday >= cfg.maxDailyLetters) {
        sendErr(req, res, 429, `今日信件已达上限（${cfg.maxDailyLetters} 封）`, { remainingToday: 0 });
        return;
      }
      // 客户端会把请求体递归转成 snake_case，所以 material.stamp_id 才是线上真实字段名。
      const stampId = String(
        body?.material?.stampId ?? body?.material?.stamp_id ?? body.stampId ?? body.stamp_id ?? "s1",
      );
      const letter = store.create(content, stampId);
      logLine(`letter ${letter.id} accepted (${content.length} chars)`);
      // 先回执，回信在后台生成；客户端靠 list/unread_count 轮询看到结果。
      replyTo(letter.id);
      sendOk(req, res, { letterId: letter.id });
      return;
    }

    if (letterPath === "/letter/list" && method === "GET") {
      const pageSize = Number(url.searchParams.get("pageSize") || url.searchParams.get("page_size") || 20) || 20;
      const items = store.sorted().map((l) => store.toListItem(l));
      const remaining = Math.max(0, cfg.maxDailyLetters - store.sentToday());
      sendOk(req, res, {
        list: items.slice(0, pageSize),
        total: items.length,
        remainingToday: remaining,
        nextCursor: "",
        hasMore: items.length > pageSize,
      });
      return;
    }

    if (letterPath === "/letter/detail" && method === "GET") {
      const id = url.searchParams.get("letterId") || url.searchParams.get("letter_id") || "";
      const letter = store.get(id);
      if (!letter) {
        sendErr(req, res, 404, "letter not found");
        return;
      }
      const detail = store.toDetail(letter);
      store.markRead(id);
      sendOk(req, res, detail);
      return;
    }

    if (letterPath === "/letter/unread_count" && method === "GET") {
      sendOk(req, res, { unreadCount: store.unreadCount() });
      return;
    }

    if (letterPath === "/letter/share" && method === "POST") {
      sendOk(req, res, { shareId: `local-${Date.now().toString(36)}` });
      return;
    }

    if (letterPath === "/letter/resend" && method === "POST") {
      const body = parseJson(await readBody(req));
      const id = String(body.letterId ?? body.letter_id ?? url.searchParams.get("letterId") ?? "");
      const letter = store.reset(id);
      if (!letter) {
        sendErr(req, res, 404, "letter not found");
        return;
      }
      replyTo(id);
      sendOk(req, res, { ok: true });
      return;
    }

    if (letterPath === "/letter/delete" && method === "POST") {
      sendOk(req, res, { ok: true });
      return;
    }

    // ── 其余 /toy/* ：礼貌地当成功，让前端流程走下去 ──────────────
    if (path.startsWith("/toy/")) {
      logLine(`benign 200 for ${method} ${path}`);
      sendOk(req, res, {});
      return;
    }

    sendErr(req, res, 404, "no such endpoint");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const message = String(error?.message ?? error);
      logLine(`handler error: ${message}`);
      try {
        sendErr(req, res, 500, message);
      } catch {
        /* 头已发出 */
      }
    });
  });

  server.on("error", (error) => {
    logLine(`server error on port ${cfg.port}: ${String(error?.message ?? error)}`);
    ctx.logger?.warn?.(`dsh-olivia-bridge: listen failed on ${cfg.host}:${cfg.port}: ${String(error?.message ?? error)}`);
  });

  server.listen(cfg.port, cfg.host, () => {
    logLine(`listening on http://${cfg.host}:${cfg.port} (preset=${cfg.presetId || "none"})`);
    ctx.logger?.info?.(`dsh-olivia-bridge: listening on http://${cfg.host}:${cfg.port}`);
  });

  ctx.effect(() => () => {
    logLine("shutting down");
    try {
      server.close();
    } catch {
      /* ignore */
    }
    void bridge.dispose();
  }, "dsh-olivia-bridge: http server + agent session");
}

export { LINLI_SYSTEM_PROMPT, STATUS, AUDIT, REPLY_TYPE };
