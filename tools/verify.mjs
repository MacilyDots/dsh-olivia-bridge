/* 端到端验证：DSH 重启后跑这个，确认桥活着、agent 能回信。
 * 用法：node tools/verify.mjs [port]
 */
const port = Number(process.argv[2] || 8791);
const base = `http://127.0.0.1:${port}`;
const t0 = Date.now();

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-uid": "verify" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

const log = (...a) => console.log(...a);

// 1) 服务是否活着
log("1) 桥是否在监听…");
try {
  const r = await api("GET", "/toy/letter/unread_count");
  log(`   HTTP ${r.status} ${JSON.stringify(r.json)}`);
} catch (error) {
  log(`   连不上 ${base}：${error.message}`);
  log("   → 插件没起来。检查 %USERPROFILE%\\.dsh\\olivia-bridge\\bridge.log，以及 DSH 启动日志里的 olivia-bridge 行。");
  process.exit(1);
}

// 2) 用户档案（客户端启动主路径）
const who = await api("GET", "/toy/getUserInfo");
log(`2) getUserInfo -> ${JSON.stringify(who.json?.data ?? who.json)}`);

// 3) 发一封测试信，等 agent 回
log("3) 投一封测试信，等回信（首次会现建 agent 会话，可能要几十秒）…");
const sent = await api("POST", "/toy/letter/send", {
  content: "（测试）今天上海下雨了，你在做什么？",
  material: { stamp_id: "s1" },
});
const letterId = sent.json?.data?.letterId;
log(`   send -> ${JSON.stringify(sent.json)}`);
if (!letterId) process.exit(1);

let last = "";
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const d = await api("GET", `/toy/letter/detail?letter_id=${letterId}`);
  const data = d.json?.data ?? {};
  const state = `letterStatus=${data.letterStatus} replyType=${data.replyType}`;
  if (state !== last) {
    log(`   [${Math.round((Date.now() - t0) / 1000)}s] ${state}`);
    last = state;
  }
  if (data.letterStatus === 4) {
    log(`\n✅ 回信成功（${Math.round((Date.now() - t0) / 1000)}s）\n--- 她写的 ---\n${data.replyText}\n--------------`);
    process.exit(0);
  }
  if (data.letterStatus === 5) {
    log(`\n❌ 生成失败：${data.failReason}`);
    log("   看 %USERPROFILE%\\.dsh\\olivia-bridge\\bridge.log 里 letter " + letterId + " 那几行。");
    process.exit(1);
  }
}
log("\n⏱ 5 分钟还没回信，看 bridge.log 里的进度。");
process.exit(1);
