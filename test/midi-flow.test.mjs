/* 「定制演奏」链路端到端测试：取上传地址 → PUT 上传 → 创建任务 → 轮询 → 我的上传 → 媒体。
 *
 * 为什么要有这个文件：这条链路以前整体落在 emptyListPaths 里（一律回空信封），
 * 所以界面上的按钮点了必然失败。现在桥真的实现了它，就必须把每一步的契约钉住：
 *   - genObjectUploadUrl 必须给出可 PUT 的 url（客户端是 `xhr.open("PUT", url)`）
 *   - midi/generate 的首答**必须是 state:1（排队）**，不能直接回完成，
 *     否则前端不会开始轮询
 *   - getGenerateResult 只在 `state===3 && info.videoUrls.length` 时算完成
 *   - searchUserSongs 的每一项要带 userSongId
 *   - 媒体要支持 Range（播放器和原生 WebPlayer 都会带 Range）
 *
 * 存储用独立 DSH_HOME 临时目录，不碰真实信件与任务。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-bridge-midi-"));

const { apply } = await import("../lib/index.js");

// ffmpeg 是可选依赖：有它就顺带验「演奏用 MP4」这条路，没有就只验 WAV 降级路径。
const ffmpegPath = [
  process.env.OLIVIA_FFMPEG,
  join(homedir(), ".dsh", "olivia-bridge", "ffmpeg", "ffmpeg.exe"),
].filter(Boolean).find((candidate) => {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}) ?? "";

const PORT = 8797;
const mockCtx = {
  logger: { info() {}, warn() {} },
  effect: (fn) => ({ dispose: fn() }),
  get: () => null,
};
apply(mockCtx, { port: PORT, presetId: "", useAgent: false, ffmpegPath });

const base = `http://127.0.0.1:${PORT}`;
let ready = false;
for (let i = 0; i < 50 && !ready; i++) {
  try {
    await fetch(`${base}/toy/letter/unread_count`);
    ready = true;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
if (!ready) {
  console.log("FAIL: 服务未能在 5s 内就绪");
  process.exit(1);
}

/** 最小合法 MIDI：format 0 / 1 轨 / 480 ticks-per-beat，一个 C4 四分音符（含延音踏板）。 */
function minimalMidi() {
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]);
  const track = [];
  const push = (...bytes) => track.push(...bytes);
  push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // tempo 500000
  push(0x00, 0xb0, 0x40, 0x7f);                   // sustain on
  push(0x00, 0x90, 0x3c, 0x64);                   // note on C4
  push(0x83, 0x60, 0x80, 0x3c, 0x40);             // delta 480, note off
  push(0x00, 0xb0, 0x40, 0x00);                   // sustain off
  push(0x00, 0xff, 0x2f, 0x00);                   // end of track
  const len = track.length;
  const trackBuf = Buffer.from([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...track]);
  return Buffer.concat([header, trackBuf]);
}

let failed = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `\n      ${extra}` : ""}`);
};

// 1) 取上传地址
const upBody = await (await fetch(`${base}/toy/genObjectUploadUrl`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ filename: "twinkle.mid", type: 12 }),
})).json();
const up = upBody?.data ?? {};
check(
  typeof up.url === "string" && up.url.includes("/toy/midi/upload/") && typeof up.key === "string" && up.headers,
  "genObjectUploadUrl 返回 {url,key,headers}",
  JSON.stringify(up).slice(0, 160),
);

// 2a) CORS 预检：浏览器在真正 PUT 之前会先问这一句，允许方法列表里没有 PUT
//     就直接拒发。命令行 fetch 完全绕开 CORS，所以这一条断言必须存在 ——
//     否则「上传失败」这类问题还会再漏一次（2026-10-07 就漏过一次）。
const preflight = await fetch(`${base}/toy/midi/upload/probe`, {
  method: "OPTIONS",
  headers: {
    origin: "https://olivia.local",
    "access-control-request-method": "PUT",
    "access-control-request-headers": "content-type",
  },
});
const allowed = preflight.headers.get("access-control-allow-methods") ?? "";
check(allowed.includes("PUT"), "CORS 预检允许 PUT", `Allow-Methods=${allowed}`);
const exposed = preflight.headers.get("access-control-expose-headers") ?? "";
check(exposed.includes("content-range"), "CORS 暴露 content-range（播放器读分片要用）", `Expose-Headers=${exposed}`);

// 2b) PUT 上传（与前端 xhr.open("PUT", url) 一致）
const putRes = await fetch(up.url, { method: "PUT", headers: up.headers ?? {}, body: minimalMidi() });
check(putRes.status >= 200 && putRes.status < 300, `PUT ${new URL(up.url).pathname} 接受上传`, `HTTP ${putRes.status}`);

// 3) 创建任务：首答必须是排队
const genBody = await (await fetch(`${base}/toy/midi/generate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ midi_url: up.key, filename: "twinkle.mid" }),
})).json();
const job = genBody?.data ?? {};
check(job.state === 1, "midi/generate 首答 state=1（排队，前端据此开始轮询）", `state=${job.state} jobId=${job.jobId}`);

// 4) 轮询到终态
let final = null;
for (let i = 0; i < 60; i++) {
  const r = await (await fetch(`${base}/toy/midi/getGenerateResult?job_id=${encodeURIComponent(job.jobId ?? "")}`)).json();
  const d = r?.data ?? {};
  if (d.state === 3 || d.state === 5) {
    final = d;
    break;
  }
  await new Promise((r2) => setTimeout(r2, 100));
}
check(final?.state === 3, "轮询到 state=3（Finished）", `state=${final?.state} error=${final?.error ?? "-"}`);
check(
  Array.isArray(final?.info?.videoUrls) && final.info.videoUrls.length > 0,
  "完成时 info.videoUrls 非空（前端判完成的唯一条件）",
  JSON.stringify(final?.info ?? {}).slice(0, 160),
);

// 5) 我的上传
const songsBody = await (await fetch(`${base}/toy/searchUserSongs?page_size=20&cursor=0`)).json();
const songs = songsBody?.data?.list ?? [];
check(
  songs.length >= 1 && typeof songs[0]?.userSongId === "string" && !!songs[0]?.audioUrl,
  "searchUserSongs 返回带 userSongId / audioUrl 的列表",
  JSON.stringify(songs[0] ?? {}).slice(0, 200),
);

// 6) 媒体本体 + Range（这里验的是试听用的 WAV；演奏用的 MP4 在第 8 步单独验）
const mediaUrl = final?.info?.audioUrl ?? "";
const full = await fetch(mediaUrl);
const buf = Buffer.from(await full.arrayBuffer());
check(
  buf.length > 44 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WAVE",
  "媒体返回合法 WAV（RIFF/WAVE）",
  `${buf.length} bytes`,
);
const ranged = await fetch(mediaUrl, { headers: { range: "bytes=0-99" } });
const rbuf = Buffer.from(await ranged.arrayBuffer());
check(
  ranged.status === 206 && rbuf.length === 100 && ranged.headers.get("content-range") === `bytes 0-99/${buf.length}`,
  "媒体支持单段 Range",
  `HTTP ${ranged.status} ${ranged.headers.get("content-range")}`,
);

// 7) 任务列表 / 批量
const jobsBody = await (await fetch(`${base}/toy/midi/listJobs?page_size=10&cursor=0`)).json();
check(Array.isArray(jobsBody?.data?.list) && jobsBody.data.list.length >= 1, "midi/listJobs 返回任务列表");
const batchBody = await (await fetch(`${base}/toy/midi/batchGetResult?job_ids=${encodeURIComponent(job.jobId ?? "")}`)).json();
check(Array.isArray(batchBody?.data?.results) && batchBody.data.results.length >= 1, "midi/batchGetResult 按 id 返回结果");

// 8) 演奏用 MP4（原生 WebPlayer 是 <video>，WAV 播不了）
if (ffmpegPath) {
  const videoUrl = final?.info?.videoUrls?.[0] ?? "";
  check(videoUrl.endsWith(".mp4"), "有 ffmpeg 时 videoUrls 指向 .mp4", videoUrl);
  const vres = await fetch(videoUrl);
  const vbuf = Buffer.from(await vres.arrayBuffer());
  check(
    vbuf.length > 1000 && vbuf.subarray(4, 8).toString() === "ftyp",
    "MP4 是合法容器（ftyp）",
    `${vbuf.length} bytes, head=${vbuf.subarray(0, 12).toString("hex")}`,
  );
  check(
    (final?.info?.audioUrl ?? "").endsWith(".wav"),
    "试听仍走 WAV（前端音频组件已实测能播）",
    final?.info?.audioUrl ?? "",
  );
} else {
  console.log("SKIP  没找到 ffmpeg，跳过 MP4 断言（降级路径：videoUrls 回落到 WAV）");
}

// 9) 歌单：加 → 幂等 → 读 → 删
const addOnce = async () => (await fetch(`${base}/toy/addToPlaylist`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ item_type: 3, item_id: job.jobId }),
})).json();
const added = (await addOnce())?.data ?? {};
check(
  added.itemId === job.jobId && added.itemType === 3 && !!added.videoUrl && typeof added.createdAt === "number",
  "addToPlaylist 回显完整条目（itemId/itemType/videoUrl/createdAt）",
  JSON.stringify(added).slice(0, 220),
);
// 前端直接 new Date(createdAt*1000)：给毫秒就会显示 Invalid Date
check(added.createdAt < 1e12, "createdAt 是 Unix 秒（毫秒会显示 Invalid Date）", `createdAt=${added.createdAt}`);

await addOnce(); // 重复加入
const plist = (await (await fetch(`${base}/toy/searchPlaylist?cursor=0&page_size=200`)).json())?.data ?? {};
check(plist.list?.length === 1, "重复加入不产生重复项", `total=${plist.total}`);
// 前端 tt() 用 itemType 决定 id：缺了它第二条就会被当成同一条（「播单只能加一个」）
check(plist.list?.[0]?.itemType === 3, "列表项带 itemType（前端的 id 由它决定）", JSON.stringify(plist.list?.[0] ?? {}).slice(0, 160));

await fetch(`${base}/toy/delFromPlaylist`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ item_type: 3, item_id: job.jobId }),
});
const plist2 = (await (await fetch(`${base}/toy/searchPlaylist?cursor=0&page_size=200`)).json())?.data ?? {};
check(plist2.list?.length === 0, "移出歌单生效", `total=${plist2.total}`);

rmSync(process.env.DSH_HOME, { recursive: true, force: true });
console.log(failed === 0 ? "\n[ALL PASS]" : `\n[${failed} FAILED]`);
process.exit(failed === 0 ? 0 : 1);
