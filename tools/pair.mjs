import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { stdin, stdout } from 'node:process';
import { ROOT } from '../src/config.mjs';
import { LocalSource } from '../src/local-source.mjs';

const { values } = parseArgs({ options: {
  server: { type: 'string' }, name: { type: 'string' },
  'code-file': { type: 'string' }, 'codex-home': { type: 'string' }, 'codex-bin': { type: 'string' },
  config: { type: 'string' }, 'read-only': { type: 'boolean', default: false },
} });
if (!values.server) throw new Error('Usage: node tools/pair.mjs --server https://your-domain.example');
const target = new URL(values.server);
if (target.protocol !== 'https:' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('Use an HTTPS website origin');
const path = resolve(values.config || join(ROOT, '.data', 'agent.remote.json'));
if (existsSync(path)) throw new Error(`Existing config preserved: ${path}. Use the existing connector, or choose a separate --config path.`);
const codexHome = realpathSync.native(values['codex-home'] || process.env.CODEX_HOME || join(homedir(), '.codex'));
const source = new LocalSource(codexHome);
const count = source.list().length; source.close();
const requestedBin = values['codex-bin'] || process.env.CODEX_BIN || 'codex';
const binName = process.platform === 'win32' && !/\.[^\\/]+$/.test(requestedBin) ? `${requestedBin}.exe` : requestedBin;
const candidates = /[\\/]/.test(binName) ? [resolve(binName)] :
  (process.env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir.replace(/^"(.*)"$/, '$1'), binName));
let codexBin = candidates.find(candidate => existsSync(candidate));
if (process.platform === 'win32' && codexBin && !codexBin.toLowerCase().endsWith('.exe')) codexBin = undefined;
if (!codexBin || !existsSync(codexBin)) throw new Error('Codex executable not found. Pass --codex-bin with the actual codex executable path.');
const version = spawnSync(codexBin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
if (version.error || version.status !== 0) throw new Error('Codex executable is not runnable; check --codex-bin before pairing.');
const name = (values.name || hostname()).trim();
if (!name || name.length > 80) throw new Error('Computer name must contain 1-80 characters');
const prompt = createInterface({ input: stdin, output: stdout });
let code;
try { code = values['code-file'] ? readFileSync(resolve(values['code-file']), 'utf8').trim() : (await prompt.question('Pairing code (5 minutes, single use): ')).trim(); }
finally { prompt.close(); }
const res = await fetch(target.origin + '/api/device-pairings/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, name }), signal: AbortSignal.timeout(15000), redirect: 'error' });
code = null;
const data = await res.json();
if (!res.ok) throw new Error(data.error || 'Pairing failed');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, JSON.stringify({ serverUrl: target.origin, deviceId: data.deviceId, agentToken: data.agentToken,
  computerName: name, codexHome, codexBin, controlsEnabled: !values['read-only'] }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
if (process.platform === 'win32') {
  const account = `${process.env.USERDOMAIN}\\${userInfo().username}`;
  const result = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'),
    [path, '/inheritance:r', '/grant:r', `${account}:(F)`, 'SYSTEM:(F)'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Paired; config saved at ${path}. File permission update failed; restrict access before starting.`);
}
console.log(JSON.stringify({ paired: true, deviceId: data.deviceId, computer: name, server: target.origin, configPath: path, localThreads: count, controlsEnabled: !values['read-only'] }));
