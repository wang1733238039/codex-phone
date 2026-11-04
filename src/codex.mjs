import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
const mutatingInput = method => ['thread/start', 'thread/fork', 'turn/start', 'turn/steer', 'thread/queue/add', 'thread/queue/start'].includes(method);

export function resolveCodexBin(configured = 'codex', { platform = process.platform, localAppData = process.env.LOCALAPPDATA } = {}) {
  if (platform !== 'win32' || !localAppData) return configured;
  const root = join(localAppData, 'OpenAI', 'Codex', 'bin');
  // Desktop updates replace the versioned binary folder. A background
  // connector can retain yesterday's PATH after that folder is removed.
  if (isAbsolute(configured) && existsSync(configured)) return configured;
  if (configured !== 'codex' && configured !== 'codex.exe' &&
      !(isAbsolute(configured) && resolve(configured).toLowerCase().startsWith(resolve(root).toLowerCase() + sep))) return configured;
  try {
    const candidates = readdirSync(root).map(name => join(root, name, 'codex.exe')).filter(existsSync);
    candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return candidates[0] || configured;
  } catch { return configured; }
}

export class CodexClient extends EventEmitter {
  constructor(config, spawnProcess = spawn) { super(); this.config = config; this.spawnProcess = spawnProcess; this.pending = new Map(); this.seq = 0; this.proc = null; }
  async start() {
    if (this.stopping) await this.stopping;
    if (this.ready) return this.ready;
    this.ready = this.boot().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async boot() {
    const proc = this.proc = this.spawnProcess(resolveCodexBin(this.config.codexBin), ['app-server', '--stdio'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: this.config.codexHome },
    });
    // Never forward raw stderr or environment to the web server.
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', error => { if (this.proc === proc) this.fail(error); });
    const disconnected = error => {
      if (this.proc !== proc) return;
      this.fail(error); this.ready = null; this.proc = null; this.emit('disconnected');
    };
    proc.on('error', disconnected);
    proc.on('exit', () => disconnected(new Error('Codex process disconnected')));
    createInterface({ input: proc.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && !msg.method && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer); this.pending.delete(msg.id);
        if (msg.error) { const error = new Error(msg.error.message); error.code = msg.error.code; reject(error); } else resolve(msg.result);
      } else if (msg.method) this.emit('message', msg);
    });
    try {
      await this.call('initialize', { clientInfo: { name: 'codex_phone', version: '0.5.0' }, capabilities: { experimentalApi: true } }, 10000);
      this.write({ method: 'initialized' });
    } catch (error) { disconnected(error); proc.kill(); throw error; }
  }
  write(message) {
    if (!this.proc || this.proc.stdin.destroyed) throw new Error('Codex is offline');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params, timeout = 45000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); const error = new Error(`Codex ${method} timed out`); error.uncertain = mutatingInput(method); reject(error); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id, result) { this.write({ id, result }); }
  fail(error) {
    for (const { reject, timer, method } of this.pending.values()) { clearTimeout(timer); const failure = new Error(error.message); failure.uncertain = mutatingInput(method); reject(failure); }
    this.pending.clear();
  }
  close() {
    this.fail(new Error('Agent stopped'));
    const proc = this.proc;
    if (!proc || this.stopping) return;
    this.ready = null;
    if (proc.closed) { this.proc = null; return; }
    this.stopping = new Promise(resolve => proc.once('close', resolve)).finally(() => { this.stopping = null; });
    proc.kill();
  }
}
