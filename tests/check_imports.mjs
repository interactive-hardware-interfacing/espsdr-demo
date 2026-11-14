// Static checks a browser would otherwise only report at run time:
// every module parses, every relative import points at a file that exists,
// and every element id the scripts look up with $('#id') is in index.html.
//   node tests/check_imports.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(join(root, 'js')).filter(f => f.endsWith('.js'));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { console.error(`✗ ${f}: ${e.stderr}`); bad++; }
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:import|from)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!existsSync(resolve(dirname(f), m[1]))) { console.error(`✗ ${f}: import ${m[1]} not found`); bad++; }
  }
  if (f.includes('/flasher/')) continue;
  for (const m of src.matchAll(/\$\('#([\w-]+)'\)/g)) {
    if (!ids.has(m[1])) { console.error(`✗ ${f}: #${m[1]} is not in index.html`); bad++; }
  }
}
for (const m of html.matchAll(/<script[^>]+src="([^"?]+)/g)) if (!existsSync(join(root, m[1]))) { console.error(`✗ index.html: ${m[1]} not found`); bad++; }
console.log(`${files.length} modules, ${ids.size} ids checked${bad ? `, ${bad} problem(s)` : ', all good'}`);
process.exit(bad ? 1 : 0);
