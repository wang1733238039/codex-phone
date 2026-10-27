import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DesktopIpc, desktopTurns } from '../vendor/agent-hub/dist/desktop-ipc.mjs';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../vendor/agent-hub/windows/desktop-pipe.ps1', import.meta.url));
const powershell = () => join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
const unwrap = result => result?.result || result || {};
const runningTurn = state => desktopTurns(state || {}).findLast(turn => turn.status === 'inProgress');
const busy = state => Boolean(runningTurn(state)) || state?.threadRuntimeStatus?.type === 'active';

/** Narrow desktop adapter. Neither wire method names nor pipe paths come from web requests. */
export class DesktopBridge {
  constructor(config, changed = () => {}, ipc) {
    this.config = config; this.changed = changed; this.ipc = ipc;
    this.approvals = new Map(); this.followed = new Set(); this.retryAt = 0; this.stopped = false;
    this.status = { connected: false, available: false };
    if (ipc) this.bind();
  }
  bind() {
    this.ipc.onSnapshot = id => { this.collectApprovals(id); this.changed(id); };
    this.ipc.onUnavailable = id => { this.followed.delete(id); this.collectApprovals(id); this.changed(id); };
    this.ipc.onDisconnect = () => { this.status.connected = false; this.approvals.clear(); this.followed.clear(); };
  }
  async connect() {
    if (this.stopped || this.config.desktopEnabled === false) return false;
    if (this.ipc?.ready) return true;
    if (process.platform === 'win32' && resolve(this.config.codexHome).toLowerCase() !==
      resolve(process.env.CODEX_HOME || join(homedir(), '.codex')).toLowerCase()) return false;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.retryAt) return false;
    this.connecting = (async () => {
      try {
        if (!['win32', 'darwin'].includes(process.platform)) return false;
        const ipc = this.ipc = new DesktopIpc(process.platform === 'win32'
          ? String.raw`\\.\pipe\codex-ipc` : join(this.config.codexHome, 'ipc', 'ipc.sock'));
        this.bind();
        if (process.platform === 'win32') {
          const { stdout } = await run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action', 'inspect'],
            { windowsHide: true, encoding: 'utf8', timeout: 15000, env: environment() });
          const identity = JSON.parse(stdout);
          if (!identity.sameUser || !identity.sameSession || !identity.trustedPublisher ||
            !/^[a-f0-9]{64}$/.test(identity.executableSha256 || '')) throw new Error('Desktop identity rejected');
          ipc.windowsIdentity = identity;
        }
        await ipc.connect();
        if (this.stopped) { ipc.close(); return false; }
        this.status = { connected: true, available: true }; return true;
      } catch {
        this.ipc?.close(); this.status = { connected: false, available: false };
        this.retryAt = Date.now() + 15000; return false;
      } finally { this.connecting = null; }
    })();
    return this.connecting;
  }
  async read(id, fresh = false) {
    if (!await this.connect()) return null;
    const state = (await this.ipc.follow(id, 2000, fresh)) || null;
    if (state) {
      const first = !this.followed.has(id); this.followed.add(id); this.collectApprovals(id);
      if (first) this.changed(id);
    }
    else this.followed.delete(id);
    return state;
  }
  activeTurns() {
    if (!this.ipc?.ready) return [];
    return [...this.followed].flatMap(threadId => {
      const active = runningTurn(this.ipc.state(threadId));
      return active ? [{ threadId, turnId: active.turnId, channel: 'desktop' }] : [];
    });
  }
  collectApprovals(threadId) {
    for (const [id, item] of this.approvals) if (item.threadId === threadId) this.approvals.delete(id);
    const state = this.ipc?.state(threadId), active = runningTurn(state);
    if (!state || !active) return;
    for (const request of state.requests || []) {
      const params = request.params || {};
      if (request.completed === true || params.threadId !== threadId || params.turnId && params.turnId !== active.turnId) continue;
      const method = { 'item/commandExecution/requestApproval': 'thread-follower-command-approval-decision',
        'item/fileChange/requestApproval': 'thread-follower-file-approval-decision' }[request.method];
      if (!method || !['string', 'number'].includes(typeof request.id)) continue;
      const id = `desktop:${threadId}:${request.id}`;
      this.approvals.set(id, { threadId, requestId: request.id, method, fingerprint: JSON.stringify(params),
        public: { id, threadId, type: request.method.includes('commandExecution') ? 'command' : 'file',
          reason: params.reason || '原桌面操作需要确认', command: params.command || '', cwd: params.cwd || '' } });
    }
  }
  runtime(id, state) {
    const turn = desktopTurns(state).at(-1), active = runningTurn(state);
    const settings = state.latestThreadSettings || {};
    this.collectApprovals(id);
    return { execution: { state: active ? 'running' : turn?.status || 'idle', owned: true,
      turnId: active?.turnId || null, verified: true, channel: 'desktop' },
      settings: { model: settings.model || state.latestModel || turn?.params?.model || '',
        effort: settings.effort ?? settings.reasoningEffort ?? state.latestReasoningEffort ?? '' } };
  }
  async command(id, method, params, validate = () => {}) {
    let written = false;
    try { return unwrap(await this.ipc.command(id, method, params, () => { validate(); written = true; })); }
    catch (error) { error.uncertain = written; throw error; }
    finally { this.changed(id); }
  }
  async send(id, data, input, selection, state) {
    const active = runningTurn(state);
    if (data.mode === 'steer') {
      if (!active) throw new Error('原桌面当前没有进行中的任务，请正常发送');
      if (data.turnId && data.turnId !== active.turnId) throw new Error('原桌面轮次已变化，请刷新后重试');
      if (Object.keys(selection).length) throw new Error('补充本轮沿用桌面正在执行的模型');
      const normalized = input.map(item => item.type === 'text' ? { ...item, text_elements: item.text_elements || [] } : item);
      const result = await this.command(id, 'thread-follower-steer-turn', {
        input: normalized, clientUserMessageId: data.requestId, attachments: [],
        restoreMessage: { id: data.requestId, text: data.text, cwd: state.cwd,
          context: { workspaceRoots: active.params?.runtimeWorkspaceRoots || [],
            collaborationMode: state.latestCollaborationMode, commentAttachments: [] } },
      }, () => {
        if (runningTurn(this.ipc.state(id))?.turnId !== active.turnId) throw new Error('原桌面轮次已变化，请刷新后重试');
      });
      return { turnId: result.turnId || active.turnId, delivery: 'steered', channel: 'desktop' };
    }
    if (busy(state) || data.mode === 'queue') return null;
    const result = await this.command(id, 'thread-follower-start-turn', {
      turnStart: { request: { threadId: id, clientUserMessageId: data.requestId, ...selection,
        input: input.map(item => item.type === 'text' ? { ...item, text_elements: item.text_elements || [] } : item),
        attachments: [], commentAttachments: [] }, context: { inheritThreadSettings: true } },
    }, () => {
      if (busy(this.ipc.state(id))) throw new Error('原桌面已开始新任务，请刷新后排队发送');
    });
    return { turnId: result.turn?.id || result.turnId || null, delivery: 'started', channel: 'desktop', ...selection };
  }
  async stop(id, expectedTurnId) {
    const state = await this.read(id, true), active = runningTurn(state);
    if (!active || expectedTurnId && expectedTurnId !== active.turnId) throw new Error('只能停止已确认归属的任务；原桌面任务已结束或轮次变化');
    await this.command(id, 'thread-follower-interrupt-turn', { mode: 'user-stop', expectedTurnId: active.turnId }, () => {
      if (runningTurn(this.ipc.state(id))?.turnId !== active.turnId) throw new Error('原桌面轮次已变化，请刷新后重试');
    });
    return { ok: true, channel: 'desktop' };
  }
  async approve(id, threadId, decision) {
    const original = this.approvals.get(id);
    if (!original || original.threadId !== threadId) throw new Error('原桌面审批已过期或目标不匹配');
    await this.read(threadId, true);
    const validate = () => {
      const request = (this.ipc.state(threadId)?.requests || []).find(p => p.id === original.requestId && p.completed !== true);
      if (!request || JSON.stringify(request.params) !== original.fingerprint) throw new Error('原桌面审批已经变化');
    };
    validate();
    let written = false;
    try {
      await this.ipc.command(threadId, original.method, { requestId: original.requestId, decision }, () => { validate(); written = true; });
      this.approvals.delete(id); return { ok: true, channel: 'desktop' };
    } catch (error) { error.uncertain = written; throw error; }
    finally { this.changed(threadId); }
  }
  close() { this.stopped = true; this.ipc?.close(); this.approvals.clear(); }
}
