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
import { MidiJobStore } from "./midi.js";
import { PlaylistStore } from "./playlist.js";

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
  // 留空 = 自动发现（环境变量 OLIVIA_FFMPEG > 桥数据目录下的 ffmpeg\ > PATH）。
  // 只有要指定某个特定 ffmpeg 时才填。
  ffmpegPath: "",
};

// 前端自己限制 MIDI < 1MB（界面文案如此），但请求体带边界、以及歌单批量等
// JSON 都可能更胖，所以上限给到 8MB。
const MAX_BODY_BYTES = 8 * 1024 * 1024;

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
  // PUT 是给 MIDI 上传用的（客户端 `xhr.open("PUT", url)`）。漏掉它，浏览器会在
  // 预检阶段就拒绝发出实际请求 —— 现象是「前端探针记到了 PUT、服务端一条都没收到」。
  // 命令行 curl / Invoke-WebRequest 不走 CORS，反而会一路绿灯，把这个问题掩盖掉。
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  const requested = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", typeof requested === "string" && requested !== "" ? requested : "content-type,x-token,x-uid,x-platform,x-bw,range");
  // 播放器要读这些响应头（尤其是 Range 分片的 content-range）。
  res.setHeader("Access-Control-Expose-Headers", "content-range,content-length,accept-ranges");
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

/** 列表类接口的「空信封」：字段取所有前端消费点的并集。
 *
 * 为什么不能只返回 `{}`：前端有 33 个接口调用点，其中不少直接对 data 里的数组
 * 调方法（`i.data.list.map(...)`、`s.data.list.map(...)`、`(await rm()).items.filter(...)`）。
 * 字段缺失就抛 TypeError → Promise 被拒 → 调用方的 loading 永远不复位 →
 * 骨架屏一直转圈。`/getSongStats` 和 `/getMusicTypeInfo` 已经各炸过一次。
 *
 * 所以这里不再逐个端点打补丁（那正是补丁循环的来源），而是让兜底返回一个
 * 「取哪个字段都不是 undefined」的形状。
 *
 * 注意 musicStyles 刻意留空数组：真正需要它的 /getMusicTypeInfo 由专用分支处理
 * （前端会取 musicStyles[0].type，空数组同样会抛错，所以那里必须给至少一项）。
 */
function emptyEnvelope() {
  return {
    list: [],
    items: [],
    results: [],
    questions: [],
    performanceList: [],
    musicStyles: [],
    performanceModes: [],
    total: 0,
    hasMore: false,
    nextCursor: "",
  };
}

/** 读原始字节体：MIDI 上传是二进制，按 utf8 解会毁掉文件。 */
function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(Buffer.alloc(0));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

/** 媒体响应。支持单段 Range —— 播放器和原生 WebPlayer 都会带 Range 取片段。 */
function sendMedia(req, res, bytes, contentType, headOnly = false) {
  applyCors(req, res);
  let start = 0;
  let end = bytes.length - 1;
  let status = 200;
  const range = req.headers.range;
  if (typeof range === "string") {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim());
    if (match) {
      const [, rawStart, rawEnd] = match;
      if (rawStart === "" && rawEnd !== "") {
        start = Math.max(0, bytes.length - Number(rawEnd));
      } else {
        start = Number(rawStart || 0);
        if (rawEnd !== "") end = Math.min(Number(rawEnd), bytes.length - 1);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= bytes.length) {
        res.writeHead(416, { "content-range": `bytes */${bytes.length}` });
        res.end();
        return;
      }
      status = 206;
    }
  }
  const slice = bytes.subarray(start, end + 1);
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": String(slice.length),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
  });
  if (headOnly) res.end();
  else res.end(slice);
}

const mediaBase = (req, fallback) => `http://${req.headers.host ?? fallback}`;

function midiPageParams(searchParams) {
  return {
    pageSize: Number(searchParams.get("page_size") ?? searchParams.get("pageSize") ?? 20) || 20,
    cursor: Number(searchParams.get("cursor") ?? 0) || 0,
  };
}

function midiJobIds(searchParams) {
  // 原客户端把 snake_case 数组序列化成重复的 query key（见 Nocturne midi-compat.js）。
  return [
    ...searchParams.getAll("job_ids"),
    ...searchParams.getAll("job_ids[]"),
    ...searchParams.getAll("jobIds"),
    ...searchParams.getAll("jobIds[]"),
  ].flatMap((value) => value.split(",")).filter(Boolean);
}

/* ── 插件主体 ───────────────────────────────────────────────────── */

export function apply(ctx, config) {
  // cordis 把 patch 行的 config 作为第二个参数传入；两种来源都兼容一下。
  const cfg = { ...DEFAULTS, ...(config || ctx?.config || {}) };
  const store = new LetterStore();
  const midiStore = new MidiJobStore({ onLog: logLine, ffmpegPath: cfg.ffmpegPath });
  const playlistStore = new PlaylistStore({ onLog: logLine });

  /** 加播单时补全曲目元数据（名字 / 媒体 URL / 时长）。曲目本体在 midiStore 里。 */
  function songMetaFor(itemId) {
    const job = midiStore.get(itemId);
    if (!job) return null;
    const song = midiStore.listUserSongs({ pageSize: 1000 }).list.find((item) => item.userSongId === itemId);
    return song ? { ...song, songId: song.userSongId } : null;
  }
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

    // ── 直接打一次 LLM（排错用）：绕开 agent 会话，拿底层真实错误 ──
    if (path === "/olivia/llm-test" && method === "POST") {
      const body = parseJson(await readBody(req));
      const result = await bridge.llmProbe(body.text);
      sendOk(req, res, result);
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
      // 客户端的消费点是：
      //   D.value = q.musicStyles;  ne.value = q.performanceModes;
      //   R.value || (R.value = q.musicStyles[0].type)   ← 空数组照样抛 TypeError
      // 所以 musicStyles 必须至少有一项、performanceModes 必须是数组。
      // 少任何一个都会让曲库页的初始化 Promise 被拒，loading 永不复位 → 骨架屏卡死。
      sendOk(req, res, {
        musicStyles: [{ type: "solo", name: "", nameKey: "" }],
        performanceModes: [],
      });
      return;
    }

    if (path === "/getSongStats" || path === "/toy/getSongStats") {
      // 消费点：const A = (await rm()).items.filter(U => U.count > 0)
      // 必须是 { items: [...] }，给空列表信封会因 .items 为 undefined 而崩。
      sendOk(req, res, { items: [] });
      return;
    }

    if (["/login", "/signout", "/toy/login", "/toy/signout"].includes(path)) {
      sendOk(req, res, {});
      return;
    }

    // ── 定制演奏（MIDI 上传 → 生成 → 我的上传 → 播放）──────────────
    // 这一段以前整体落在 emptyListPaths 里，所以界面上按钮有了、点了必然失败。
    const midiPath = path.startsWith("/toy/") ? path.slice(4) : path;
    const fallbackHost = `${cfg.host}:${cfg.port}`;

    const mediaMatch = midiPath.match(/^\/midi\/media\/([^/]+?)(?:\.(wav|mp4))?$/u);
    if (mediaMatch && (method === "GET" || method === "HEAD")) {
      const extension = mediaMatch[2] ?? "wav";
      const bytes = midiStore.mediaBytes(mediaMatch[1], extension);
      if (!bytes) {
        sendErr(req, res, 404, "media_not_found");
        return;
      }
      sendMedia(req, res, bytes, extension === "mp4" ? "video/mp4" : "audio/wav", method === "HEAD");
      return;
    }

    if (midiPath === "/genObjectUploadUrl" && method === "POST") {
      const body = parseJson(await readBody(req));
      const upload = midiStore.createUpload({
        filename: String(body.filename ?? "upload.mid"),
        uploadUrl: mediaBase(req, fallbackHost),
      });
      logLine(`midi: upload url issued for ${upload.filename}`);
      sendOk(req, res, { url: upload.url, key: upload.key, headers: upload.headers });
      return;
    }

    const uploadMatch = midiPath.match(/^\/midi\/upload\/([^/]+)$/u);
    if (uploadMatch && method === "PUT") {
      const bytes = await readRawBody(req);
      if (!bytes.length) {
        sendErr(req, res, 400, "empty upload");
        return;
      }
      try {
        sendOk(req, res, midiStore.receiveUpload(decodeURIComponent(uploadMatch[1]), bytes));
      } catch (error) {
        sendErr(req, res, 404, String(error?.message ?? error));
      }
      return;
    }

    if (midiPath === "/midi/generate" && method === "POST") {
      const body = parseJson(await readBody(req));
      try {
        const job = midiStore.generate({
          midiUrl: String(body.midiUrl ?? body.midi_url ?? ""),
          filename: String(body.filename ?? ""),
          mediaBaseUrl: mediaBase(req, fallbackHost),
        });
        // 首答必须是「排队」= state:1，前端据此开始轮询（不能直接回完成）。
        sendOk(req, res, midiStore.clientJob(job, mediaBase(req, fallbackHost)));
      } catch (error) {
        sendErr(req, res, 400, String(error?.message ?? error));
      }
      return;
    }

    if (midiPath === "/midi/getGenerateResult" && method === "GET") {
      const jobId = url.searchParams.get("jobId") ?? url.searchParams.get("job_id") ?? "";
      sendOk(req, res, midiStore.clientJob(midiStore.get(jobId), mediaBase(req, fallbackHost)));
      return;
    }

    if (midiPath === "/midi/listJobs" && method === "GET") {
      const page = midiStore.list(midiPageParams(url.searchParams));
      const base = mediaBase(req, fallbackHost);
      sendOk(req, res, { ...page, list: page.list.map((job) => midiStore.clientJob(job, base)) });
      return;
    }

    if (midiPath === "/midi/batchGetResult" && method === "GET") {
      const base = mediaBase(req, fallbackHost);
      const jobs = midiStore.batch(midiJobIds(url.searchParams)).list;
      sendOk(req, res, { results: jobs.map((job) => midiStore.clientJob(job, base)), ...midiStore.dailyUsage() });
      return;
    }

    if (midiPath === "/midi/cancelGenerate" && method === "POST") {
      const body = parseJson(await readBody(req));
      const job = midiStore.cancel(body.jobId ?? body.job_id ?? url.searchParams.get("jobId"));
      sendOk(req, res, midiStore.clientJob(job, mediaBase(req, fallbackHost)));
      return;
    }

    if (midiPath === "/midi/deleteJob" && method === "POST") {
      const body = parseJson(await readBody(req));
      const deleted = midiStore.delete(body.jobId ?? body.job_id ?? url.searchParams.get("jobId"));
      sendOk(req, res, { deleted });
      return;
    }

    if (midiPath === "/midi/importShareCode" && method === "POST") {
      // 分享码是官方服务端能力，本地不伪造成功。
      sendErr(req, res, 409, "midi_share_code_not_supported");
      return;
    }

    if (midiPath === "/searchUserSongs" && method === "GET") {
      sendOk(req, res, midiStore.listUserSongs(midiPageParams(url.searchParams)));
      return;
    }

    // ── 歌单（「加播单」/「音乐桌面」）────────────────────────────────
    // 以前这里走 emptyEnvelope()：返回体里没有 itemType/itemId，前端拿到的
    // `id` 是 undefined → 第二条加进去被判成重复（「播单只能加一个」）；
    // 列表项也没有 createdAt，于是显示 Invalid Date。
    if (midiPath === "/addToPlaylist" && method === "POST") {
      const body = parseJson(await readBody(req));
      const itemType = Number(body.itemType ?? body.item_type ?? 3) || 3;
      const itemId = String(body.itemId ?? body.item_id ?? "");
      const item = playlistStore.add({ itemType, itemId, describe: songMetaFor });
      logLine(`playlist: add ${itemType}:${itemId} (${item.name})`);
      sendOk(req, res, item);
      return;
    }

    if (midiPath === "/delFromPlaylist" && method === "POST") {
      const body = parseJson(await readBody(req));
      sendOk(req, res, playlistStore.remove({
        itemType: Number(body.itemType ?? body.item_type ?? 0) || 0,
        itemId: String(body.itemId ?? body.item_id ?? ""),
      }));
      return;
    }

    if (midiPath === "/searchPlaylist" && method === "GET") {
      sendOk(req, res, playlistStore.list(midiPageParams(url.searchParams)));
      return;
    }

    // ── 官方曲库：没有实现（本地根本没有曲目媒体，见 HANDOVER §6.6）──
    const emptyListPaths = ["/searchSongs"];
    if (emptyListPaths.some((p) => path === p || path === `/toy${p}`)) {
      sendOk(req, res, emptyEnvelope());
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

    // ── 其余 /toy/* ：礼貌地当成功，并给出字段完备的空信封 ────────
    // 这里以前返回 {}，于是任何没被显式列出的列表接口（例如前端会
    // `s.data.list.map(...)` 的 /searchPerformances）都会抛 TypeError，
    // 骨架屏卡死。统一走 emptyEnvelope()，与 emptyListPaths 同一形状。
    if (path.startsWith("/toy/")) {
      logLine(`benign 200 for ${method} ${path}`);
      sendOk(req, res, emptyEnvelope());
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
