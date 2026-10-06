/* 校验 profile 的 cordis.patch.yml 是否仍是合法 YAML。
 * 文件里有 cordis 自定义的 !!js 标签，需要注册类型才能解析。
 *
 * 用法：node test/validate-profile-yaml.mjs [profile 名，默认 desktop]
 * profile 目录 = $DSH_HOME（默认 %USERPROFILE%\.dsh）\profiles\<profile>
 * 需要该 profile 里装过 js-yaml。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', process.argv[2] || 'desktop');

const yamlPath = join(profileDir, 'node_modules', 'js-yaml', 'index.js');
const yaml = (await import(pathToFileURL(yamlPath).href)).default;

const file = join(profileDir, 'cordis.patch.yml');
const text = readFileSync(file, 'utf8');

const JsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d) => d });
const schema = yaml.DEFAULT_SCHEMA.extend([JsTag]);

try {
  const doc = yaml.load(text, { schema });
  const rows = Array.isArray(doc) ? doc.length : -1;
  console.log(`YAML OK — 顶层条目 ${rows} 个`);
  // 找出 olivia 相关条目
  const flat = [];
  const walk = (n, depth = 0) => {
    if (Array.isArray(n)) n.forEach((x) => walk(x, depth));
    else if (n && typeof n === 'object') {
      if (typeof n.id === 'string' && n.id.includes('olivia')) flat.push(`${n.id} (name=${n.name ?? '-'})`);
      if (n.insert) walk(n.insert, depth + 1);
    }
  };
  walk(doc);
  console.log('olivia 相关条目: ' + (flat.length ? flat.join(' | ') : '无'));
} catch (error) {
  console.log(`YAML ERROR: ${error.message}`);
  process.exit(1);
}
