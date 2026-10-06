// 解码 bridge.log 里的探针记录，看清前端到底在请求什么
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const log = readFileSync(join(process.env.USERPROFILE, '.dsh', 'olivia-bridge', 'bridge.log'), 'utf8');
const rows = [];

for (const line of log.split('\n')) {
  const m = line.match(/\/olivia\/(xhr|fetch|js-reject|js-error|probe-from-game|patch[0-9-]*\w*)\?d=(\S+)/);
  if (!m) continue;
  try {
    const data = JSON.parse(decodeURIComponent(m[2]));
    rows.push({ kind: m[1], data });
  } catch {
    rows.push({ kind: m[1], data: { raw: m[2].slice(0, 200) } });
  }
}

console.log(`=== 共 ${rows.length} 条探针记录 ===\n`);
for (const r of rows) {
  if (r.kind === 'xhr' || r.kind === 'fetch') {
    const rewritten = r.data.to ? `  ==>  ${r.data.to}` : '';
    console.log(`[${r.data.m || 'fetch'}] ${r.data.u}${rewritten}`);
  } else {
    console.log(`[${r.kind}] ${JSON.stringify(r.data)}`);
  }
}
