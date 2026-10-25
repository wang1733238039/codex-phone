import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.mjs';
if (!existsSync(join(ROOT, '.data', 'server.json'))) await import('./setup.mjs');
const children = ['src/server.mjs', 'src/agent.mjs'].map(file => spawn(process.execPath, [join(ROOT, file)], { cwd: ROOT, stdio: 'inherit', windowsHide: true }));
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill(); setTimeout(() => process.exit(code), 300).unref(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) { child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => stop(code || 0)); }
