import WebSocket from 'ws';
import { hostname } from 'node:os';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { LocalSource, validThreadId } from './local-source.mjs';
import { CodexClient } from './codex.mjs';
import { loadConfig } from './config.mjs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentAttachments } from './agent-attachments.mjs';
import { buildInputs, attachmentText } from './attachment-common.mjs';
import { DesktopBridge } from './desktop.mjs';

export class Agent {
  constructor(config) {
    this.config = config; this.source = new LocalSource(config.codexHome); this.codex = new CodexClient(config);
    this.attachments = new AgentAttachments(config);
    this.ws = null; this.stopped = false; this.active = new Map(); this.approvals = new Map(); this.inflight = new Set(); this.changedTimers = new Map(); this.reconnectCount = 0;
    this.queuedHere = new Map(); this.turnState = new Map(); this.modelCache = null; this.reading = 0;
    this.desktop = new DesktopBridge(config, id => { this.changed(id); this.state(); });
    this.codex.on('message', msg => this.onCodex(msg));
    this.codex.on('disconnected', () => { this.active.clear(); this.approvals.clear(); this.state(); });
    const target = new URL(config.serverUrl);
    if (!['http:', 'https:'].includes(target.protocol) || target.pathname !== '/') throw new Error('serverUrl must be an HTTP(S) origin');
    if (target.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && !config.allowInsecureLan) throw new Error('Remote agent connection requires HTTPS');
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'; target.pathname = '/agent'; this.target = target;
  }
  send(message) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  activeTurns() {
    const turns = new Map(this.desktop.activeTurns().map(turn => [turn.threadId, turn]));
    for (const [threadId, turnId] of this.active) turns.set(threadId, { threadId, turnId });
    return [...turns.values()];
  }
  state() { this.send({ type: 'state', activeTurns: this.activeTurns(), approvals: [...this.approvals.values(), ...this.desktop.approvals.values()].map(p => p.public) }); }
  snapshot() {
    try { this.send({ type: 'snapshot', ...this.source.snapshot(), info: { computer: this.config.computerName || hostname(), controls: Boolean(this.config.controlsEnabled),
      version: '0.6.0', desktop: this.desktop.status, capabilities: { queue: true, models: true, executionStatus: true, steer: true, attachments: true, createThread: true, activity: true, desktopControl: true } },
      activeTurns: this.activeTurns(), approvals: [...this.approvals.values(), ...this.desktop.approvals.values()].map(p => p.public) }); }
    catch (error) { console.error('Local index unavailable:', error.message); }
  }
  connect() {
    if (this.stopped) return;
    const ws = this.ws = new WebSocket(this.target, { headers: { Authorization: `Bearer ${this.config.agentToken}`,
      ...(this.config.deviceId ? { 'X-Device-Id': this.config.deviceId } : {}) }, maxPayload: 512 * 1024, handshakeTimeout: 15000 });
    ws.on('open', () => { this.reconnectCount = 0; console.log('Agent connected'); this.snapshot(); });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.stopped) return;
      console.log('Agent disconnected; reconnecting');
      this.retry = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** Math.min(this.reconnectCount++, 5)));
    });
    ws.on('message', async raw => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'request' || typeof msg.id !== 'string') return;
      const reply = message => { if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
      try { const data = await this.handle(msg.action, msg.data || {}); reply({ type: 'response', id: msg.id, data }); }
      catch (error) { reply({ type: 'response', id: msg.id, error: this.friendlyError(error), uncertain: Boolean(error.uncertain) }); }
    });
  }
  friendlyError(error) {
    const text = String(error.message || '操作失败').replaceAll(this.config.agentToken, '[redacted]');
    if (this.activeWriterError(error)) return '桌面仍持有此会话。可选择“跟随会话”将消息加入桌面队列；模型切换和立即执行需要会话写入权限。';
    return text.slice(0, 1200);
  }
  activeWriterError(error) {
    return /already has an active writer|active writer|writer.*lock|lock.*writer/i.test(String(error?.message || ''));
  }
  async models() {
    if (this.modelCache && Date.now() - this.modelCache.at < 60000) return this.modelCache.data;
    this.reading++; clearTimeout(this.idleTimer);
    try {
      await this.codex.start();
      const models = []; let cursor;
      do {
        const result = await this.codex.call('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
        models.push(...(result.data || [])); cursor = result.nextCursor;
      } while (cursor && models.length < 1000);
      const data = models.filter(m => !m.hidden).map(m => ({ id: m.model || m.id, name: m.displayName || m.model || m.id,
        efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort, isDefault: Boolean(m.isDefault) }));
      this.modelCache = { at: Date.now(), data }; return data;
    } finally { this.reading--; this.releaseWhenIdle(); }
  }
  async selection(data) {
    if (!data.model && !data.effort) return {};
    if (!data.model) throw new Error('请选择模型后再设置思考强度');
    const model = (await this.models()).find(m => m.id === data.model);
    if (!model || data.effort && !model.efforts.includes(data.effort)) throw new Error('此电脑未提供所选模型或思考强度，请刷新模型列表');
    return { model: model.id, ...(data.effort ? { effort: data.effort } : {}) };
  }
  async queue(threadId, data, track = false) {
    const result = await this.codex.call('thread/queue/add', { threadId, clientUserMessageId: data.requestId || randomUUID(),
      input: await this.inputs(data) });
    if (!result.queuedSubmission?.id) { const error = new Error('未能确认 Codex 排队结果，请核对消息状态'); error.uncertain = true; throw error; }
    const queueId = result.queuedSubmission.id;
    if (track || this.active.has(threadId)) {
      const tracked = this.queuedHere.get(threadId) || new Set(); tracked.add(queueId); this.queuedHere.set(threadId, tracked);
    }
    this.state(); this.changed(threadId);
    return { queued: true, queueId, delivery: 'queued', model: null };
  }
  async runtime(threadId, detail) {
    this.reading++; clearTimeout(this.idleTimer);
    const ownedTurn = this.active.get(threadId);
    let runtime, queue = [], statusError, desktopState;
    if (!ownedTurn) {
      try { desktopState = await this.desktop.read(threadId); } catch {}
    }
    try {
      await this.codex.start();
      const read = await this.codex.call('thread/read', { threadId, includeTurns: false }, 10000);
      runtime = read.thread;
      if ((ownedTurn || this.turnState.get(threadId)?.state === 'running') && ['idle', 'systemError'].includes(runtime?.status?.type)) {
        this.active.delete(threadId);
        this.turnState.set(threadId, { state: runtime.status.type === 'systemError' ? 'failed' : detail.turnStatus === 'running' ? 'interrupted' : detail.turnStatus,
          updatedAt: Date.now(), lastActivityAt: detail.lastActivityAt });
        this.state();
      }
      const queued = await this.codex.call('thread/queue/list', { threadId, limit: 100 }, 10000);
      queue = (queued.data || []).map(q => ({ id: q.id, requestId: q.clientUserMessageId,
        ...attachmentText((q.input || []).filter(i => i.type === 'text').map(i => i.text).join('\n').slice(0, 48000)) }));
    } catch (error) { statusError = this.friendlyError(error); }
    finally { this.reading--; this.releaseWhenIdle(); }
    const active = this.active.get(threadId), terminal = this.turnState.get(threadId);
    const state = active ? 'running' : runtime?.status?.type === 'systemError' ? 'failed' :
      runtime?.status?.type === 'idle' ? (terminal?.state || (detail.running ? 'interrupted' : detail.turnStatus || 'idle')) :
      detail.running ? 'unconfirmed' : (detail.turnStatus || 'idle');
    return { queue, queueKnown: !statusError, execution: { state, owned: Boolean(active), turnId: active || null,
      lastActivityAt: Math.max(detail.lastActivityAt || 0, terminal?.lastActivityAt || 0), error: terminal?.error,
      verified: Boolean(active || ['idle', 'systemError'].includes(runtime?.status?.type)), statusError },
      settings: { model: runtime?.model || '', effort: runtime?.reasoningEffort || '' },
      ...(desktopState ? this.desktop.runtime(threadId, desktopState) : {}) };
  }
  async handle(action, data) {
    if (action === 'create-thread') return this.createThread(data);
    if (action === 'detail') {
      const detail = await this.source.detail(data.threadId);
      detail.ownedTurn = this.active.get(data.threadId) || null;
      return this.config.controlsEnabled ? { ...detail, ...await this.runtime(data.threadId, detail) } : detail;
    }
    if (action === 'models') return { models: await this.models() };
    if (['attachment-start', 'attachment-chunk', 'attachment-finish'].includes(action)) {
      if (!this.config.controlsEnabled) throw new Error('电脑连接程序未开启操作权限');
      if (!validThreadId(data.threadId)) throw new Error('会话编号无效');
      const row = this.source.row(data.threadId);
      if (row.archived || !this.source.isLocal(row)) throw new Error('只能向本机未归档会话上传材料');
      return this.attachments[action.slice(11)](data);
    }
    if (!['send', 'stop', 'approve', 'queue-start', 'queue-delete'].includes(action)) throw new Error('Unsupported action');
    if (!this.config.controlsEnabled) throw new Error('电脑连接程序未开启操作权限');
    if (action === 'approve') {
      if (typeof data.id === 'string' && data.id.startsWith('desktop:')) {
        if (!validThreadId(data.threadId) || !['accept', 'decline', 'cancel'].includes(data.decision)) throw new Error('审批参数无效');
        const row = this.source.row(data.threadId);
        if (row.archived || !this.source.isLocal(row)) throw new Error('原桌面审批目标不可用');
        return this.desktop.approve(data.id, data.threadId, data.decision);
      }
      const p = this.approvals.get(data.id);
      if (!p || (data.threadId && p.public.threadId !== data.threadId) || !['accept', 'decline', 'cancel'].includes(data.decision)) throw new Error('此审批已结束或参数不正确');
      this.codex.respond(p.rpcId, { decision: data.decision }); this.approvals.delete(data.id); this.state(); return { ok: true };
    }
    if (!validThreadId(data.threadId)) throw new Error('Invalid thread ID');
    if (action === 'queue-delete') {
      if (typeof data.queueId !== 'string' || !data.queueId) throw new Error('排队编号无效');
      await this.codex.start();
      try {
        await this.codex.call('thread/queue/delete', { threadId: data.threadId, queuedSubmissionId: data.queueId });
        this.queuedHere.get(data.threadId)?.delete(data.queueId); this.changed(data.threadId); return { ok: true };
      } finally { this.releaseWhenIdle(); }
    }
    if (action === 'stop') {
      const turnId = this.active.get(data.threadId);
      if (!turnId) {
        const row = this.source.row(data.threadId);
        if (row.archived || !this.source.isLocal(row)) throw new Error('原桌面目标不可用');
        return this.desktop.stop(data.threadId, data.turnId);
      }
      if (data.turnId && turnId !== data.turnId) throw new Error('此轮任务已结束，请刷新后重试');
      await this.codex.call('turn/interrupt', { threadId: data.threadId, turnId }); return { ok: true };
    }
    if (action === 'send' && (typeof data.text !== 'string' || (!data.text.trim() && !data.attachments?.length) || data.text.length > 32000)) throw new Error('Invalid message');
    if (this.inflight.has(data.threadId)) throw new Error('正在提交上一条消息，请稍后再次提交');
    const row = this.source.row(data.threadId);
    if (row.archived) throw new Error('此会话已归档，请先在电脑恢复后再续聊');
    if (!this.source.isLocal(row)) throw new Error('此会话的工作目录不在本机，此连接程序只执行本机任务');
    this.inflight.add(data.threadId);
    try {
      const selection = await this.selection(data);
      const active = this.active.get(data.threadId);
      if (!active && action === 'send') {
        const desktopState = await this.desktop.read(data.threadId, true);
        if (desktopState) {
          const result = await this.desktop.send(data.threadId, data, await this.inputs(data), selection, desktopState);
          if (result) return result;
          if (Object.keys(selection).length) throw new Error('原桌面任务进行中；排队请跟随会话模型，或等本轮结束后切换模型');
          await this.codex.start();
          return await this.queue(data.threadId, data);
        }
      }
      await this.codex.start();
      if (active) {
        if (action === 'queue-start') throw new Error('当前任务仍在执行，排队消息将在本轮结束后继续');
        if (data.mode === 'steer') {
          if (Object.keys(selection).length) throw new Error('补充本轮沿用正在执行的模型；切换模型请选择排队发送');
          const result = await this.codex.call('turn/steer', { threadId: data.threadId, expectedTurnId: active,
            clientUserMessageId: data.requestId, input: await this.inputs(data) });
          this.changed(data.threadId); return { turnId: result.turnId || active, delivery: 'steered' };
        }
        if (Object.keys(selection).length) await this.codex.call('thread/settings/update', { threadId: data.threadId, ...selection });
        return await this.queue(data.threadId, data);
      }
      if (data.mode === 'steer') throw new Error('本轮已结束或不由此连接程序执行；请选择正常 / 排队发送');
      try {
        await this.codex.call('thread/resume', { threadId: data.threadId, excludeTurns: true });
      } catch (error) {
        // The desktop app owns the thread while it is open. Queue the phone
        // input through the official app-server API instead of making the
        // user close the desktop app or losing the message.
        if (!this.activeWriterError(error)) throw error;
        if (action !== 'send' || Object.keys(selection).length || data.mode === 'steer') throw error;
        return await this.queue(data.threadId, data);
      }
      if (action === 'send') {
        const waiting = await this.codex.call('thread/queue/list', { threadId: data.threadId, limit: 1 });
        if (waiting.data?.length) {
          if (Object.keys(selection).length) await this.codex.call('thread/settings/update', { threadId: data.threadId, ...selection });
          const queued = await this.queue(data.threadId, data, true);
          // Completion and a new submit can race. Append to the existing queue
          // rather than starting a newer message ahead of an older one.
          setTimeout(() => this.drainQueue(data.threadId), 150).unref();
          return queued;
        }
      }
      // A stale log marker is not a runtime lock. Let Codex decide whether a new
      // turn can start, preserving all existing thread permission settings.
      const result = action === 'queue-start'
        ? await this.codex.call('thread/queue/start', { threadId: data.threadId, queuedSubmissionId: data.queueId || null })
        : await this.codex.call('turn/start', { threadId: data.threadId, clientUserMessageId: data.requestId, ...selection,
          input: await this.inputs(data) });
      if (result.turn?.id && result.turn.status === 'inProgress') this.active.set(data.threadId, result.turn.id);
      this.state(); this.changed(data.threadId); return { turnId: result.turn?.id || null, delivery: 'started', ...selection };
    } finally { this.inflight.delete(data.threadId); this.releaseWhenIdle(); }
  }
  async inputs(data) {
    return buildInputs(data.text, await this.attachments.selected(data.threadId, data.attachments || []));
  }
  async createThread(data) {
    if (!this.config.controlsEnabled) throw new Error('电脑连接程序未开启操作权限');
    if (typeof data.title !== 'string' || data.title.length > 120 || data.projectId != null && typeof data.projectId !== 'string') throw new Error('新建参数无效');
    const project = data.projectId ? this.source.snapshot().sidebar.projects.find(p => p.id === data.projectId) : null;
    if (data.projectId && !project) throw new Error('项目不存在，请刷新列表后重试');
    let cwd;
    if (project) {
      cwd = data.rootPath || project.rootPaths[0];
      if (!project.rootPaths.includes(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('所选项目目录不可用，请在电脑上检查');
      if (!project.nativeId) throw new Error('此项目尚未迁移到当前 Codex，请先在桌面打开项目');
    } else {
      if (data.rootPath) throw new Error('无项目对话不能指定任意目录');
      cwd = resolve(this.config.codexHome, 'phone-workspace'); mkdirSync(cwd, { recursive: true });
    }
    this.reading++; clearTimeout(this.idleTimer);
    try {
      await this.codex.start();
      const started = await this.codex.call('thread/start', { cwd, ephemeral: false, ...(project ? { projectId: project.nativeId } : {}) });
      const id = started.thread?.id;
      if (!validThreadId(id)) { const error = new Error('新建结果尚未确认，请刷新列表，勿重复创建'); error.uncertain = true; throw error; }
      let warning;
      try { await this.codex.call('thread/name/set', { threadId: id, name: data.title.trim() || '手机新对话' }); }
      catch { warning = '对话已创建，标题暂未更新'; }
      // Persist an empty conversation through the native runtime, before its first turn.
      let indexed;
      try { indexed = this.source.snapshot().threads.find(t => t.id === id); } catch {}
      const thread = indexed || {
        id, title: data.title.trim() || '手机新对话', preview: '', cwd, archived: false, local: true,
        createdAt: Date.now(), updatedAt: Date.now(), projectId: project?.id || null, projectName: project?.name || '', source: 'cli'
      };
      this.snapshot(); this.changed(id);
      await this.codex.call('thread/unsubscribe', { threadId: id }).catch(() => {});
      return { thread, warning };
    } finally { this.reading--; this.releaseWhenIdle(); }
  }
  releaseWhenIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.active.size && !this.inflight.size && !this.approvals.size && !this.reading) this.codex.close(); }, 1500);
  }
  async drainQueue(threadId) {
    if (this.stopped || this.active.has(threadId) || this.inflight.has(threadId)) return;
    const tracked = this.queuedHere.get(threadId);
    if (tracked?.size) {
      try {
        this.inflight.add(threadId); await this.codex.start();
        const list = await this.codex.call('thread/queue/list', { threadId, limit: 100 });
        const next = list.data?.[0];
        // Never start someone else's queued message or reorder the desktop queue.
        if (next && tracked.has(next.id)) {
          const result = await this.codex.call('thread/queue/start', { threadId, queuedSubmissionId: next.id });
          tracked.delete(next.id);
          if (result.turn?.status === 'inProgress') this.active.set(threadId, result.turn.id);
          this.state(); this.changed(threadId); return;
        }
      } catch (error) { this.turnState.set(threadId, { state: 'unconfirmed', error: this.friendlyError(error) }); }
      finally { this.inflight.delete(threadId); this.releaseWhenIdle(); }
    }
    this.codex.call('thread/unsubscribe', { threadId }).catch(() => {}); this.releaseWhenIdle();
  }
  changed(threadId) {
    if (this.changedTimers.has(threadId)) return;
    this.changedTimers.set(threadId, setTimeout(() => { this.changedTimers.delete(threadId); this.send({ type: 'changed', threadId }); }, 700));
  }
  onCodex(msg) {
    const p = msg.params || {}, threadId = p.threadId || p.thread?.id;
    if (threadId) {
      const last = this.turnState.get(threadId) || {};
      this.turnState.set(threadId, { ...last, lastActivityAt: Date.now() });
    }
    if (msg.id != null) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) {
        const id = randomUUID();
        this.approvals.set(id, { rpcId: msg.id, public: { id, threadId, type: msg.method.includes('commandExecution') ? 'command' : 'file',
          reason: p.reason || '此操作需要你的确认', command: p.command || '', cwd: p.cwd || '' } });
        this.state();
      } else {
        // Unknown tools/permissions are never auto-approved.
        this.codex.write({ id: msg.id, error: { code: -32601, message: 'This phone client cannot handle this request. Continue in desktop Codex.' } });
      }
      return;
    }
    if (msg.method === 'turn/started' && threadId) { this.active.set(threadId, p.turn.id); this.turnState.set(threadId, { state: 'running', lastActivityAt: Date.now() }); }
    if (msg.method === 'turn/completed' && threadId) {
      this.active.delete(threadId);
      this.turnState.set(threadId, { state: p.turn?.status || 'completed', lastActivityAt: Date.now(), error: p.turn?.error?.message?.slice(0, 500) });
      for (const [key, value] of this.approvals) if (value.public.threadId === threadId) this.approvals.delete(key);
      this.snapshot();
      // Release this client's subscription once a turn ends so desktop can resume later.
      setTimeout(() => this.drainQueue(threadId), 150).unref();
    }
    if (msg.method === 'serverRequest/resolved') {
      for (const [id, approval] of this.approvals) if (String(approval.rpcId) === String(p.requestId)) this.approvals.delete(id);
      this.state();
    }
    if (threadId) this.changed(threadId);
    if (msg.method === 'turn/started' || msg.method === 'turn/completed') this.state();
  }
  start() { this.connect(); this.interval = setInterval(() => this.snapshot(), this.config.syncIntervalMs || 10000); }
  close() {
    this.stopped = true; clearTimeout(this.retry); clearTimeout(this.idleTimer); clearInterval(this.interval);
    for (const timer of this.changedTimers.values()) clearTimeout(timer);
    this.ws?.close(); this.desktop.close(); this.codex.close(); this.source.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const agent = new Agent(loadConfig('agent')); agent.start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { agent.close(); process.exit(0); });
}
