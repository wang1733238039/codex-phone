import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
const mutatingInput = method => ['thread/start', 'turn/start', 'turn/steer', 'thread/queue/add', 'thread/queue/start'].includes(method);

export class CodexClient extends EventEmitter {
  constructor(config) { super(); this.config = config; this.pending = new Map(); this.seq = 0; this.proc = null; }
  async start() {
    if (this.stopping) await this.stopping;
    if (this.ready) return this.ready;
    this.ready = this.boot().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async boot() {
    const proc = this.proc = spawn(this.config.codexBin || 'codex', ['app-server', '--stdio'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: this.config.codexHome },
    });
    // Never forward raw stderr or environment to the web server.
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', error => this.fail(error));
    proc.on('error', error => this.fail(error));
    proc.on('exit', () => { this.fail(new Error('Codex process disconnected')); this.ready = null; this.proc = null; this.emit('disconnected'); });
    createInterface({ input: proc.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && !msg.method && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer); this.pending.delete(msg.id);
        if (msg.error) { const error = new Error(msg.error.message); error.code = msg.error.code; reject(error); } else resolve(msg.result);
      } else if (msg.method) this.emit('message', msg);
    });
    await this.call('initialize', { clientInfo: { name: 'codex_phone', version: '0.5.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
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
    this.stopping = new Promise(resolve => proc.once('close', resolve)).finally(() => { this.stopping = null; });
    proc.kill();
  }
}
