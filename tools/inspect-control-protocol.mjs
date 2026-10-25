// Read-only diagnostics; never logs prompts, credentials or provider configuration.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexClient } from '../src/codex.mjs';
import { loadConfig, ROOT } from '../src/config.mjs';

const config = loadConfig('agent');
const out = resolve(ROOT, '.data', 'protocol-inspection');
mkdirSync(out, { recursive: true });
const version = spawnSync(config.codexBin, ['--version'], { encoding: 'utf8', windowsHide: true });
console.log(JSON.stringify({ version: version.stdout?.trim(), bin: config.codexBin }));
const generated = spawnSync(config.codexBin, ['app-server', 'generate-json-schema', '--experimental', '--out', out],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
console.log(JSON.stringify({ generated: generated.status === 0, output: out, error: generated.status ? generated.stderr?.slice(0, 1000) : undefined }));
const client = new CodexClient(config);
try {
  await client.start();
  for (const [method, params] of [['model/list', { includeHidden: true }], ['thread/queue/list', { threadId: '00000000-0000-0000-0000-000000000000' }]]) {
    try {
      const value = await client.call(method, params, 15000);
      writeFileSync(resolve(out, method.replaceAll('/', '-') + '.json'), JSON.stringify(value, null, 2) + '\n', 'utf8');
      console.log(JSON.stringify({ method, result: value }));
    } catch (error) { console.log(JSON.stringify({ method, error: error.message })); }
  }
} finally { client.close(); }
