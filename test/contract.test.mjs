/* 契约层自测：用 mock ctx 起插件自带的 HTTP 服务，打一遍客户端会打的接口。
 * 这里没有真实的 DSH 环境，agent 桥会失败——正好验证失败路径不会拖垮服务。
 *
 * 存储隔离：用独立的 DSH_HOME 临时目录跑。旧版本直接 rmSync 真实路径下的
 * letters.json，那会删掉用户正在用的真实信件，所以这里必须隔离。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-bridge-contract-"));

const { apply } = await import("../lib/index.js");

const PORT = 8799;
const mockCtx = {
  logger: { info: (m) => console.log("[ctx.info]", m), warn: (m) => console.log("[ctx.warn]", m) },
  effect: (fn) => {
    const dispose = fn();
    return { dispose };
  },
  get: () => null,
};

apply(mockCtx, { port: PORT, presetId: "", maxDailyLetters: 20 });
await new Promise((r) => setTimeout(r, 400));

const base = `http://127.0.0.1:${PORT}`;
const out = [];
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-token": "toy_test", "x-uid": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  out.push(`${method} ${path} -> HTTP ${res.status}\n${JSON.stringify(parsed)}`);
  return parsed;
}

// 启动时序：本地无 uid 时走 signIn，之后每次启动走 getUserInfo
await call("POST", "/toy/signIn", { username: "旅人" });
await call("GET", "/toy/getUserInfo");
await call("GET", "/toy/getMusicTypeInfo");
// 真实客户端发的 body 是 snake_case
await call("POST", "/toy/letter/send", { content: "今天路过琴房，听见有人在弹《夜曲》。", material: { stamp_id: "s3" } });
await call("GET", "/toy/letter/list?page_size=20");
await call("GET", "/toy/letter/unread_count");
await call("GET", "/toy/letter/detail?letter_id=1");
await call("GET", "/toy/letter/unread_count");
await call("POST", "/toy/letter/resend", { letter_id: "1" });
await call("GET", "/toy/searchPlaylist?page_size=200");
await call("POST", "/toy/midi/importShareCode", { share_code: "abc" });
await call("GET", "/toy/letter/detail?letter_id=999");

console.log(out.join("\n\n"));
await new Promise((r) => setTimeout(r, 900));
rmSync(process.env.DSH_HOME, { recursive: true, force: true });
process.exit(0);
