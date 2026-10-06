// 读会话事件（多帧 zstd）并打印 turn/end 的 reason，用来拿模型调用的真实错误
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressAll(buf) {
  const parts = [];
  let start = buf.indexOf(MAGIC);
  let frames = 0;
  while (start >= 0 && start < buf.length) {
    const next = buf.indexOf(MAGIC, start + 4);
    const end = next === -1 ? buf.length : next;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
      frames++;
    } catch (e) {
      parts.push(`\n[frame decode error @${start}: ${e.message}]\n`);
    }
    start = next;
  }
  return { text: parts.join(''), frames };
}

const root = join(process.env.USERPROFILE, '.dsh', 'sessions');
const wanted = process.argv[2] || 'olivia-letterbox';

for (const dir of readdirSync(root)) {
  const base = join(root, dir);
  let names;
  try {
    names = readdirSync(base);
  } catch {
    continue;
  }
  for (const name of names) {
    if (!name.startsWith(wanted)) continue;
    const file = join(base, name, 'session.v4.jsonl.zstd');
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const { text, frames } = decompressAll(readFileSync(file));
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    console.log(`\n===== ${name} =====`);
    console.log(`文件 ${st.size} 字节 / 解出 ${lines.length} 事件 / ${frames} 帧`);

    const counts = {};
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        counts[ev.type] = (counts[ev.type] || 0) + 1;
      } catch {}
    }
    console.log('事件类型: ' + JSON.stringify(counts));

    for (const line of lines) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'turn/end' || ev.type === 'error' || /error|fail/i.test(String(ev.type))) {
        console.log(`\n--- ${ev.type} ---`);
        console.log(JSON.stringify(ev.data ?? ev).slice(0, 1600));
      }
    }
  }
}
