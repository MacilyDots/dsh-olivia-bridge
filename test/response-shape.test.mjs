/* 响应形状契约测试 —— 锁住「前端解构不会抛 TypeError」这条底线。
 *
 * 为什么需要它：前端主脚本里有 33 个接口调用点，其中不少直接对 data 里的数组
 * 调方法，例如
 *     Vn:  t.data.performanceModes.map(...)，且调用方还要 q.musicStyles[0].type
 *     rm:  (await rm()).items.filter(...)
 *     Yp:  s.data.list.map(...)
 * 桥一旦漏字段就抛 TypeError → Promise 被拒 → 调用方的 loading 永远不复位 →
 * 界面骨架屏一直转圈。`/getSongStats` 与 `/getMusicTypeInfo` 已经各炸过一次，
 * 都是靠人肉逆向才定位的。
 *
 * 这个文件把前端真正消费的字段钉死：以后新增接口漏字段会先在这里变红，
 * 而不是等到游戏里转圈再逆向一遍。
 *
 * 存储用独立的 DSH_HOME（临时目录），绝不碰 ~/.dsh/olivia-bridge/letters.json
 * —— 那是用户的真实信件。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-bridge-shape-"));

const { apply } = await import("../lib/index.js");

const PORT = 8798;
const mockCtx = {
  logger: { info() {}, warn() {} },
  effect: (fn) => ({ dispose: fn() }),
  get: () => null,
};
apply(mockCtx, { port: PORT, presetId: "", useAgent: false });

const base = `http://127.0.0.1:${PORT}`;
// apply() 是同步注册、listen 是异步完成的，先等端口真的能应答。
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

const arr = Array.isArray;

/** [路径, 前端消费点, 断言] */
const CASES = [
  ["/toy/getMusicTypeInfo", "q.musicStyles[0].type 与 q.performanceModes.map", (d) => arr(d.musicStyles) && d.musicStyles.length >= 1 && arr(d.performanceModes)],
  ["/toy/getSongStats", "(await rm()).items.filter(...)", (d) => arr(d.items)],
  ["/toy/getPreferenceSurvey", "t.data.questions", (d) => arr(d.questions)],
  ["/toy/searchSongs", "i.data.list.map(...)", (d) => arr(d.list)],
  ["/toy/searchPlaylist", "s.data.list.map(...)", (d) => arr(d.list)],
  ["/toy/searchUserSongs", "(s.data.list??[]).map(...)", (d) => arr(d.list)],
  ["/toy/searchPerformances", "s.data.list.map(...) 与 s.data.nextCursor", (d) => arr(d.list) && d.nextCursor !== undefined],
  ["/toy/midi/listJobs", "s.data 与 s.data.list", (d) => arr(d.list) && typeof d.total === "number"],
  ["/toy/midi/batchGetResult", "s.data 与 s.data.results", (d) => arr(d.results)],
  ["/toy/letter/list", "s.data.list", (d) => arr(d.list)],
  ["/toy/letter/unread_count", "t.data.unreadCount", (d) => typeof d.unreadCount === "number"],
];

let failed = 0;
for (const [path, consumer, check] of CASES) {
  let data = {};
  let note = "";
  try {
    const res = await fetch(base + path);
    const body = await res.json();
    data = body?.data ?? {};
    if (body?.code !== 0) note = ` (code=${body?.code} ${body?.message})`;
  } catch (error) {
    note = ` (${error.message})`;
  }
  const ok = check(data);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${path}${note}`);
  console.log(`      <- ${consumer}`);
  console.log(`      data=${JSON.stringify(data).slice(0, 150)}`);
}

// 兜底：任何没被显式列出的 /toy/* 也必须给字段完备的空信封。
// 这是本次修复的核心 —— 以前兜底返回 {}，/searchPerformances 就是这么崩的。
const unknown = await (await fetch(`${base}/toy/endpointThatDoesNotExist`)).json();
const uok =
  arr(unknown?.data?.list) &&
  arr(unknown?.data?.items) &&
  arr(unknown?.data?.results) &&
  unknown?.data?.nextCursor !== undefined;
if (!uok) failed++;
console.log(`${uok ? "PASS" : "FAIL"}  /toy/endpointThatDoesNotExist (benign fallback envelope)`);
console.log(`      data=${JSON.stringify(unknown?.data)}`);

rmSync(process.env.DSH_HOME, { recursive: true, force: true });
console.log(failed === 0 ? "\n[ALL PASS]" : `\n[${failed} FAILED]`);
process.exit(failed === 0 ? 0 : 1);
