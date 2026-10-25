import { LocalSource } from '../src/local-source.mjs';
import { loadConfig } from '../src/config.mjs';
import { realpathSync } from 'node:fs';
const source = new LocalSource(loadConfig('agent').codexHome);
try {
  const row = source.row(source.list()[0].id);
  console.log(JSON.stringify({ pathPrefix: row.rollout_path.slice(0, 50), homePrefix: source.home.slice(0, 40) }));
  for (const [name, fn] of [['realpath', realpathSync], ['native', realpathSync.native]]) {
    try { const p = fn(row.rollout_path); console.log(JSON.stringify({ name, prefix: p.slice(0, 50), success: true })); }
    catch (e) { console.log(JSON.stringify({ name, error: e.message })); }
  }
} finally { source.close(); }
