// 解压并打印桥 agent 会话的事件日志（zstd JSONL）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = join(process.env.USERPROFILE, '.dsh', 'sessions');
// 会话按「工作区转义名」分目录，逐个都扫，不假设本机是哪个工作区
const dirs = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

for (const d of dirs) {
  const base = join(root, d);
  for (const name of readdirSync(base)) {
    if (!name.startsWith('olivia-letterbox')) continue;
    const file = join(base, name, 'session.v4.jsonl.zstd');
    let stat;
    try {
      stat = statSync(file);
    } catch {
      console.log(`\n### ${name} — 无 session 文件`);
      continue;
    }
    console.log(`\n### ${name} (${stat.size} bytes compressed, ${stat.mtime.toISOString()})`);
    try {
      const text = zstdDecompressSync(readFileSync(file)).toString('utf8');
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      console.log(`事件数: ${lines.length}`);
      for (const line of lines.slice(-25)) {
        try {
          const ev = JSON.parse(line);
          const type = ev.type ?? ev.kind ?? '?';
          const detail = JSON.stringify(ev.data ?? ev).slice(0, 400);
          console.log(`  [${type}] ${detail}`);
        } catch {
          console.log(`  (raw) ${line.slice(0, 300)}`);
        }
      }
    } catch (error) {
      console.log(`  解压失败: ${error.message}`);
    }
  }
}
