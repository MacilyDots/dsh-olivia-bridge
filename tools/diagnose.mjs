/* 重启后一键诊断：先看静态状态，再让 agent 真跑一轮。
 * 用法：node tools/diagnose.mjs [port]
 */
const port = Number(process.argv[2] || 8791);
const base = `http://127.0.0.1:${port}`;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

console.log(`=== 1. 静态诊断 ${base}/olivia/diag ===`);
const diag = await call("GET", "/olivia/diag");
console.log(JSON.stringify(diag.json ?? diag, null, 2));

console.log(`\n=== 2. 让 agent 跑一轮 ${base}/olivia/agent-test ===`);
const t0 = Date.now();
const probe = await call("POST", "/olivia/agent-test");
console.log(`耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(JSON.stringify(probe.json ?? probe, null, 2));
