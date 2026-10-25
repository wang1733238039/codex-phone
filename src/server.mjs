import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store, credentialHash } from './store.mjs';
import { ROOT, loadConfig, equalSecret } from './config.mjs';
import { validThreadId } from './local-source.mjs';
import { compareThreads, sidebarGroups } from './sidebar.mjs';
import { pathToFileURL } from 'node:url';
import { ServerAttachments } from './server-attachments.mjs';
import { CHUNK_BYTES } from './attachment-common.mjs';
import { Accounts } from './accounts.mjs';
import { isIP } from 'node:net';

const sha = s => createHash('sha256').update(s).digest('hex');
const cookieName = 'codex_phone';
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function createApp(config) {
  if (!config.agentToken || !config.passwordHash) throw new Error('Missing agent token or password hash');
  const rootStore = new Store(config.database || resolve(ROOT, '.data', 'cache.sqlite'), config.ownerId || 'personal');
  const accounts = new Accounts(rootStore, config);
  const attachmentManager = new ServerAttachments(rootStore, config.database || resolve(ROOT, '.data', 'cache.sqlite'), config);
  attachmentManager.ready.catch(() => {});
  rootStore.initializePrimary(config.agentToken);
  const secure = Boolean(config.publicUrl?.startsWith('https://'));
  const sessions = rootStore.db;
  const publicOrigin = config.publicUrl ? new URL(config.publicUrl).origin : null;
  const allowedHosts = new Set(config.allowedHosts || ['localhost', '127.0.0.1', '[::1]']);
  if (publicOrigin) allowedHosts.add(new URL(publicOrigin).hostname);
  const pending = new Map(), lateResponses = new Map(), listeners = new Map(), loginAttempts = new Map(), pairingAttempts = new Map(), agents = new Map();
  let closing = false;
  let expiryTimer;
  const online = deviceId => {
    const connection = agents.get(deviceId);
    return Boolean(connection?.ws.readyState === 1 && Date.now() - connection.lastSeen < 45000);
  };
  const deviceStatus = (deviceId = rootStore.primaryDeviceId, ownerId = rootStore.ownerId) => {
    const store = rootStore.forOwner(ownerId);
    const connection = agents.get(deviceId), connected = Boolean(store.device(deviceId) && accounts.access(accounts.get(ownerId)) === 'active' && online(deviceId));
    return { deviceId, online: connected, lastSeen: connection?.lastSeen || 0, lastSync: store.lastSync(deviceId),
      computer: store.device(deviceId)?.name || '未连接电脑', connectionId: connected ? connection.id : null,
      controls: accounts.access(accounts.get(ownerId)) === 'active' && Boolean(config.controlsEnabled) && connection?.controls !== false,
      capabilities: connection?.capabilities || {}, connectorVersion: connection?.version || null,
      activeTurns: connected ? connection.activeTurns : [], approvals: connected ? connection.approvals : [] };
  };
  function broadcast(deviceId, type = 'changed', data = {}) {
    const event = `event: ${type}\ndata: ${JSON.stringify({ ...data, deviceId })}\n\n`;
    for (const [res, listener] of listeners) if (listener.deviceId === deviceId) res.write(event);
  }
  function directoryChanged(ownerId) {
    for (const [res, listener] of listeners) if (listener.ownerId === ownerId && listener.deviceId === null) res.write('event: devices\ndata: {}\n\n');
  }
  function disconnect(connection) {
    if (agents.get(connection.deviceId) !== connection) return;
    agents.delete(connection.deviceId);
    for (const [id, p] of pending) if (p.connection === connection) {
      clearTimeout(p.timer); pending.delete(id); p.reject(new HttpError(503, '电脑连接中断；执行结果暂未确认，请先刷新会话'));
    }
    for (const [id, p] of lateResponses) if (p.connection === connection) lateResponses.delete(id);
    broadcast(connection.deviceId, 'status'); directoryChanged(connection.ownerId);
  }
  function subscribe(req, res, sessionId, deviceId, ownerId) {
    if (listeners.size >= 1024 || [...listeners.values()].filter(l => l.ownerId === ownerId).length >= 16) throw new HttpError(429, '打开的页面过多');
    headers(res, 'text/event-stream'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
    listeners.set(res, { sessionId, deviceId, ownerId });
    res.write(`event: ${deviceId === null ? 'devices' : 'status'}\ndata: {}\n\n`);
    req.on('close', () => listeners.delete(res));
  }
  function limit(map, key, count, windowMs) {
    let item = map.get(key);
    if (!item || item.until < Date.now()) { item = { count: 0, until: Date.now() + windowMs }; map.set(key, item); }
    if (++item.count > count) throw new HttpError(429, '尝试次数过多，请稍后重试');
  }
  function clientAddress(req) {
    const socketAddress = req.socket.remoteAddress;
    // Accept proxy headers only from addresses explicitly configured by the operator.
    const forwarded = req.headers['x-real-ip'];
    return config.trustedProxies?.includes(socketAddress) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : socketAddress;
  }
  function getSession(req) {
    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token || token.length > 200) return null;
    return sessions.prepare(`SELECT s.* FROM sessions s JOIN accounts a ON s.owner_id=a.id
      WHERE s.id=? AND s.expires>? AND a.status='active'`).get(sha(token), Date.now()) || null;
  }
  function sessionPayload(session) {
    const account = session && accounts.get(session.owner_id), store = account && rootStore.forOwner(account.id);
    return { authenticated: Boolean(account), csrf: session?.csrf, username: account?.username,
      primaryDeviceId: store?.primaryDeviceId, account: account ? accounts.public(account) : undefined };
  }
  function createSession(account, res, previous) {
    if (previous) {
      sessions.prepare('DELETE FROM sessions WHERE id=?').run(previous.id);
      for (const [stream, listener] of listeners) if (listener.sessionId === previous.id) { stream.end(); listeners.delete(stream); }
    }
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url'), id = sha(token);
    sessions.prepare('INSERT INTO sessions(id,csrf,expires,owner_id) VALUES (?,?,?,?)')
      .run(id, csrf, Date.now() + 7 * 86400000, account.id);
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}`);
    return sessionPayload({ id, csrf, owner_id: account.id });
  }
  function revokeSessions(ownerId) {
    sessions.prepare('DELETE FROM sessions WHERE owner_id=?').run(ownerId);
    for (const [stream, listener] of listeners) if (listener.ownerId === ownerId) { stream.end(); listeners.delete(stream); }
  }
  function enforceAccount(ownerId, notify = true) {
    const access = accounts.access(accounts.get(ownerId));
    if (access !== 'active') {
      sessions.prepare('DELETE FROM pairings WHERE owner_id=?').run(ownerId);
      for (const connection of agents.values()) if (connection.ownerId === ownerId) { disconnect(connection); connection.ws.terminate(); }
      if (access !== 'expired') revokeSessions(ownerId);
    }
    if (notify) {
      for (const [stream, listener] of listeners) if (listener.ownerId === ownerId) stream.write('event: account\ndata: {}\n\n');
      directoryChanged(ownerId);
    }
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (closing) return;
    const next = sessions.prepare("SELECT MIN(expires_at) deadline FROM accounts WHERE status='active' AND expires_at>?").get(Date.now()).deadline;
    if (next == null) return;
    expiryTimer = setTimeout(() => {
      for (const account of sessions.prepare("SELECT id FROM accounts WHERE status='active' AND expires_at>=? AND expires_at<=?").all(next, Date.now())) enforceAccount(account.id);
      scheduleExpiry();
    }, Math.min(2147483647, Math.max(1, next - Date.now())));
    expiryTimer.unref();
  }
  async function deleteAccount(ownerId, actor) {
    accounts.markDeleted(ownerId, actor); enforceAccount(ownerId);
    scheduleExpiry();
    await attachmentManager.purgeOwner(ownerId);
  }
  function headers(res, type = 'application/json; charset=utf-8') {
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  function json(res, code, body) { headers(res); res.writeHead(code); res.end(JSON.stringify(body)); }
  function requireOrigin(req) {
    const expected = publicOrigin || `http://${req.headers.host}`;
    if (req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请求来源验证失败，请从本站重新登录');
  }
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256 * 1024) throw new HttpError(413, '输入内容过长');
      chunks.push(chunk);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid object');
      return parsed;
    }
    catch { throw new HttpError(400, '请求格式错误'); }
  }
  function ask(deviceId, action, data = {}, timeout = 25000, onLateResult) {
    const connection = agents.get(deviceId);
    if (connection) accounts.requireActive(connection.ownerId);
    if (!online(deviceId)) return Promise.reject(new HttpError(503, '电脑已离线，请联网后再操作'));
    const id = randomUUID();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        const p = pending.get(id); pending.delete(id);
        if (onLateResult && p) lateResponses.set(id, { connection, onLateResult, expires: Date.now() + 120000 });
        reject(new HttpError(504, '电脑响应超时；发送操作可能已执行，请先刷新会话，不要重复发送'));
      }, timeout);
      pending.set(id, { resolve: resolveRequest, reject, timer, connection });
      connection.ws.send(JSON.stringify({ type: 'request', id, action, data }));
    });
  }
  const staticFiles = new Map([
    ['/', ['public/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
    ['/inbox.js', ['public/inbox.js', 'text/javascript; charset=utf-8']],
    ['/attachments.js', ['public/attachments.js', 'text/javascript; charset=utf-8']],
    ['/accounts.js', ['public/accounts.js', 'text/javascript; charset=utf-8']],
    ['/accounts.css', ['public/accounts.css', 'text/css; charset=utf-8']],
    ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
    ['/conversation.css', ['public/conversation.css', 'text/css; charset=utf-8']],
    ['/icon.svg', ['public/icon.svg', 'image/svg+xml']],
    ['/device-icons.svg', ['public/device-icons.svg', 'image/svg+xml']],
    ['/downloads/codex-phone-agent.zip', ['public/downloads/codex-phone-agent.zip', 'application/zip']],
    ['/downloads/CONNECT-ANOTHER-COMPUTER.md', ['public/downloads/CONNECT-ANOTHER-COMPUTER.md', 'text/markdown; charset=utf-8']],
    ['/manifest.webmanifest', ['public/manifest.webmanifest', 'application/manifest+json']],
    ['/vendor/marked.js', ['node_modules/marked/lib/marked.umd.js', 'text/javascript; charset=utf-8']],
    ['/vendor/purify.js', ['node_modules/dompurify/dist/purify.min.js', 'text/javascript; charset=utf-8']],
  ]);
  const server = http.createServer(async (req, res) => {
    try {
      let url;
      try { url = new URL(req.url, 'http://local'); } catch { throw new HttpError(400, '无效地址'); }
      let host;
      try { host = new URL(`http://${req.headers.host}`).hostname; } catch { throw new HttpError(400, '无效主机'); }
      if (!allowedHosts.has(host)) throw new HttpError(403, '此访问域名未配置，请设置 publicUrl 或 allowedHosts');
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [path, type] = staticFiles.get(url.pathname);
        headers(res, type); res.end(readFileSync(resolve(ROOT, path))); return;
      }
      if (req.method === 'GET' && url.pathname === '/healthz') { json(res, 200, { ok: true }); return; }
      if (req.method === 'POST' && url.pathname === '/api/device-pairings/claim') {
        if (req.headers.origin && req.headers.origin !== publicOrigin) throw new HttpError(403, '请求来源验证失败');
        limit(pairingAttempts, `claim:${clientAddress(req)}`, 30, 60000);
        const data = await body(req);
        const code = typeof data.code === 'string' ? data.code.toUpperCase().replace(/[-\s]/g, '') : '';
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code) || !name || name.length > 80) throw new HttpError(400, '请填写有效配对码和电脑名称');
        const token = randomBytes(48).toString('base64url');
        const device = accounts.claimDevice(credentialHash(code), name, token);
        if (!device) throw new HttpError(400, '配对码已过期或已使用，请重新生成');
        directoryChanged(device.ownerId); json(res, 201, { deviceId: device.id, name: device.name, agentToken: token }); return;
      }
      const session = getSession(req);
      if (req.method === 'POST' && url.pathname === '/api/register') {
        requireOrigin(req); limit(loginAttempts, `register:${clientAddress(req)}`, 8, 900000);
        const account = await accounts.register(await body(req));
        scheduleExpiry();
        json(res, 201, createSession(account, res, session)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        requireOrigin(req);
        const ip = clientAddress(req);
        let attempts = loginAttempts.get(ip);
        if (!attempts || attempts.until < Date.now()) { attempts = { count: 0, until: Date.now() + 900000 }; loginAttempts.set(ip, attempts); }
        if (attempts.count >= 8) throw new HttpError(429, '尝试次数过多，请 15 分钟后重试');
        attempts.count++;
        const data = await body(req);
        const account = await accounts.authenticate(data.username, data.password);
        if (!account) throw new HttpError(401, '账号或密码不正确');
        loginAttempts.delete(ip);
        json(res, 200, createSession(account, res, session)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        json(res, 200, sessionPayload(session)); return;
      }
      if (!session) throw new HttpError(401, '请先登录');
      if (req.method !== 'GET') {
        requireOrigin(req);
        if (!equalSecret(req.headers['x-csrf-token'], session.csrf)) throw new HttpError(403, '登录验证失效，请重新登录');
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        sessions.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
        for (const [stream, listener] of listeners) if (listener.sessionId === session.id) { stream.end(); listeners.delete(stream); }
        res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
        json(res, 200, { ok: true }); return;
      }
      const ownerId = session.owner_id, store = rootStore.forOwner(ownerId);
      const attachments = attachmentManager.forStore(store, () => accounts.requireActive(ownerId));
      const status = deviceId => deviceStatus(deviceId, ownerId);
      if (req.method === 'GET' && url.pathname === '/api/account') {
        json(res, 200, { account: accounts.public(accounts.get(ownerId)) }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/account/password') {
        limit(loginAttempts, `password:${ownerId}`, 8, 900000);
        const data = await body(req); await accounts.changePassword(ownerId, data.currentPassword, data.newPassword);
        revokeSessions(ownerId);
        json(res, 200, { ok: true, loginRequired: true }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/account/delete') {
        limit(loginAttempts, `delete:${ownerId}`, 5, 900000);
        const data = await body(req);
        if (data.confirmUsername !== accounts.get(ownerId).username || !await accounts.checkPassword(ownerId, data.password)) throw new HttpError(403, '请核对账号和密码');
        await deleteAccount(ownerId, ownerId); json(res, 200, { ok: true }); return;
      }
      if (url.pathname.startsWith('/api/admin/')) {
        accounts.requireAdmin(ownerId);
        const target = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)(?:\/(password|delete))?$/);
        const invitation = url.pathname.match(/^\/api\/admin\/invitations\/([^/]+)\/revoke$/);
        if (req.method === 'GET' && url.pathname === '/api/admin/accounts') {
          const offset = Number(url.searchParams.get('offset') || 0);
          if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, '分页参数无效');
          json(res, 200, accounts.list((url.searchParams.get('q') || '').slice(0, 100), offset)); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/accounts') {
          limit(loginAttempts, `admin-create:${ownerId}`, 30, 60000);
          const account = await accounts.create(await body(req), ownerId); scheduleExpiry();
          json(res, 201, { account: accounts.public(account) }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/invitations') {
          json(res, 200, { invitations: accounts.invitations() }); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/invitations') {
          limit(loginAttempts, `invite:${ownerId}`, 30, 60000);
          json(res, 201, accounts.invite(await body(req), ownerId)); return;
        }
        if (req.method === 'POST' && invitation) {
          accounts.revokeInvitation(invitation[1], ownerId); json(res, 200, { ok: true }); return;
        }
        if (req.method === 'POST' && target) {
          const [, id, action] = target, data = await body(req);
          if (action === 'password') {
            limit(loginAttempts, `admin-password:${ownerId}`, 30, 60000);
            await accounts.resetPassword(id, data.password, ownerId); revokeSessions(id);
            json(res, 200, { ok: true }); return;
          }
          if (action === 'delete') {
            if (data.confirmUsername !== accounts.get(id)?.username) throw new HttpError(400, '请输入要删除的完整账号');
            await deleteAccount(id, ownerId); json(res, 200, { ok: true }); return;
          }
          const account = accounts.update(id, data, ownerId); enforceAccount(id); scheduleExpiry();
          json(res, 200, { account: accounts.public(account) }); return;
        }
        throw new HttpError(404, '找不到此管理操作');
      }
      // Expired accounts may read their own cache and revoke devices, but no new work is forwarded.
      const cleanupRoute = /^\/api\/devices\/[a-f\d-]+\/(?:revoke|rename)$/i.test(url.pathname);
      if (req.method !== 'GET' && !cleanupRoute) accounts.requireActive(ownerId);
      if (accounts.access(accounts.get(ownerId)) !== 'active') enforceAccount(ownerId, false);
      if (req.method === 'GET' && url.pathname === '/api/agent-package') {
        headers(res, 'application/zip'); res.setHeader('Content-Disposition', 'attachment; filename="codex-phone-agent.zip"');
        res.end(readFileSync(resolve(ROOT, 'public/downloads/codex-phone-agent.zip'))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/connection-guide') {
        headers(res, 'text/markdown; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="CONNECT-ANOTHER-COMPUTER.md"');
        res.end(readFileSync(resolve(ROOT, 'public/downloads/CONNECT-ANOTHER-COMPUTER.md'))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/devices') {
        json(res, 200, { account: accounts.public(accounts.get(ownerId)), primaryDeviceId: store.primaryDeviceId, devices: store.devices().map(d => ({ id: d.id, name: d.name, ...status(d.id) })) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/devices/events') { subscribe(req, res, session.id, null, ownerId); return; }
      if (req.method === 'POST' && url.pathname === '/api/device-pairings') {
        limit(pairingAttempts, `create:${session.id}`, 20, 60000);
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = [...randomBytes(12)].map(b => alphabet[b % alphabet.length]).join('');
        const expiresAt = Date.now() + 300000;
        store.pairing(credentialHash(code), expiresAt);
        json(res, 201, { code: code.match(/.{4}/g).join('-'), expiresAt }); return;
      }
      const deviceRoute = url.pathname.match(/^\/api\/devices\/([a-f\d-]+)(\/.*)$/i);
      const deviceId = deviceRoute ? deviceRoute[1] : store.primaryDeviceId;
      const route = deviceRoute ? `/api${deviceRoute[2]}` : url.pathname;
      if (!deviceId || !store.device(deviceId)) throw new HttpError(404, '找不到此电脑，可能已解绑');
      if (req.method === 'POST' && route === '/api/rename') {
        const data = await body(req), name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name || name.length > 80) throw new HttpError(400, '电脑名称应为 1–80 个字符');
        store.rename(deviceId, name); broadcast(deviceId, 'status'); directoryChanged(ownerId); json(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && route === '/api/revoke') {
        store.revoke(deviceId);
        const connection = agents.get(deviceId);
        if (connection) { disconnect(connection); connection.ws.terminate(); }
        for (const [stream, listener] of listeners) if (listener.deviceId === deviceId) {
          stream.write('event: revoked\ndata: {}\n\n'); stream.end(); listeners.delete(stream);
        }
        directoryChanged(ownerId); json(res, 200, { ok: true }); return;
      }
      if (req.method === 'GET' && route === '/api/status') { json(res, 200, status(deviceId)); return; }
      if (req.method === 'GET' && route === '/api/models') {
        if (!online(deviceId)) throw new HttpError(503, '电脑离线，无法读取模型列表');
        const data = await ask(deviceId, 'models');
        json(res, 200, { models: Array.isArray(data.models) ? data.models : [] }); return;
      }
      const commandId = route.match(/^\/api\/commands\/([a-f\d-]+)$/i)?.[1];
      if (req.method === 'GET' && commandId) {
        const command = store.command(deviceId, commandId);
        json(res, 200, command ? { state: command.state, result: command.payload ? JSON.parse(command.payload) : null } : { state: 'not_found' }); return;
      }
      if (req.method === 'GET' && route === '/api/events') { subscribe(req, res, session.id, deviceId, ownerId); return; }
      if (req.method === 'POST' && route === '/api/threads') {
        if (!config.controlsEnabled || agents.get(deviceId)?.controls === false) throw new HttpError(403, '当前仅允许查看会话');
        const data = await body(req);
        if (!validThreadId(data.requestId) || typeof data.title !== 'string' || data.title.length > 120 ||
            data.projectId != null && (typeof data.projectId !== 'string' || data.projectId.length > 200) ||
            data.rootPath != null && (typeof data.rootPath !== 'string' || data.rootPath.length > 4096)) throw new HttpError(400, '新建对话参数无效');
        const previous = store.command(deviceId, data.requestId);
        if (previous) {
          if (previous.thread_id !== '__create__') throw new HttpError(409, '请求编号已使用');
          json(res, 200, { state: previous.state, result: previous.payload ? JSON.parse(previous.payload) : null, duplicate: true }); return;
        }
        if (!online(deviceId)) throw new HttpError(503, '电脑离线，无法新建对话');
        if (!status(deviceId).capabilities.createThread) throw new HttpError(409, '此电脑连接程序需升级至 0.5.0 才能新建对话');
        limit(pairingAttempts, `new-thread:${session.id}`, 20, 60000);
        store.beginCommand(deviceId, data.requestId, '__create__');
        const finish = message => {
          if (!message.error && !validThreadId(message.data?.thread?.id)) {
            message = { error: '电脑返回的新建结果无效，请刷新列表核对', uncertain: true };
          }
          store.finishCommand(deviceId, data.requestId, message.error ? message.uncertain ? 'unknown' : 'failed' : 'accepted',
            message.error ? { error: message.error } : message.data);
          if (!message.error) {
            store.saveThread(message.data.thread, deviceId);
            if (!store.detail(message.data.thread.id, deviceId)) store.saveDetail(message.data.thread.id, { id: message.data.thread.id, transcriptVersion: 2, messages: [], running: false, turnStatus: 'idle' }, deviceId);
            broadcast(deviceId, 'list');
          }
        };
        try {
          const result = await ask(deviceId, 'create-thread', { title: data.title, projectId: data.projectId, rootPath: data.rootPath }, config.commandTimeoutMs || 60000, finish);
          finish({ data: result });
          const saved = store.command(deviceId, data.requestId);
          json(res, 200, { state: saved.state, result: JSON.parse(saved.payload) });
        } catch (error) {
          store.finishCommand(deviceId, data.requestId, error.status === 503 || error.status === 504 ? 'unknown' : 'failed', { error: error.message });
          throw error;
        }
        return;
      }
      if (req.method === 'GET' && route === '/api/threads') {
        const q = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
        const archived = url.searchParams.get('archived') === 'true';
        const all = store.list(deviceId), sidebar = store.sidebar(deviceId);
        const threads = all.filter(t => t.archived === archived && (!q || `${t.title}\n${t.preview}\n${t.cwd}\n${t.projectName || ''}`.toLocaleLowerCase().includes(q)))
          .sort((a, b) => compareThreads(a, b, sidebar));
        json(res, 200, { threads, sidebar, groups: sidebarGroups(threads, sidebar, { archived, searching: Boolean(q) }), total: all.filter(t => !t.archived).length, archivedCount: all.filter(t => t.archived).length, ...status(deviceId) }); return;
      }
      const attachmentRoute = route.match(/^\/api\/threads\/([a-f\d-]+)\/attachments(?:\/([a-f\d-]+)(?:\/(complete|sync|content))?)?$/i);
      if (attachmentRoute) {
        const [, threadId, attachmentId, action] = attachmentRoute, thread = store.thread(threadId, deviceId);
        if (!validThreadId(threadId) || !thread) throw new HttpError(404, '找不到此会话');
        if (req.method === 'GET' && attachmentId) {
          if (action === 'content') { await attachments.content(deviceId, threadId, attachmentId, req, res, headers); return; }
          if (!action) { json(res, 200, attachments.public(attachments.get(deviceId, threadId, attachmentId))); return; }
        }
        if (!config.controlsEnabled || agents.get(deviceId)?.controls === false || thread.archived || thread.local === false) throw new HttpError(403, '此会话当前不能上传材料');
        if (req.method === 'DELETE' && attachmentId && !action) { json(res, 200, await attachments.remove(deviceId, threadId, attachmentId)); return; }
        if (!online(deviceId)) throw new HttpError(503, '电脑离线，请上线后上传或重试');
        if (!status(deviceId).capabilities.attachments) throw new HttpError(409, '此电脑连接程序需升级至 0.4.0 才能接收附件');
        if (req.method === 'POST' && !attachmentId) {
          json(res, 201, await attachments.create(deviceId, threadId, await body(req))); return;
        }
        if (req.method === 'PUT' && attachmentId && !action) {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > CHUNK_BYTES) throw new HttpError(413, '附件分块过大'); chunks.push(chunk); }
          const rawOffset = url.searchParams.get('offset');
          if (!/^\d+$/.test(rawOffset || '')) throw new HttpError(400, '附件断点无效');
          json(res, 200, await attachments.chunk(deviceId, threadId, attachmentId, Number(rawOffset), Buffer.concat(chunks))); return;
        }
        if (req.method === 'POST' && attachmentId && action === 'complete') { json(res, 200, await attachments.complete(deviceId, threadId, attachmentId)); return; }
        if (req.method === 'POST' && attachmentId && action === 'sync') { json(res, 200, await attachments.sync(deviceId, threadId, attachmentId, ask)); return; }
        throw new HttpError(404, '找不到此附件操作');
      }
      const match = route.match(/^\/api\/threads\/([a-f\d-]+)(?:\/(send|stop|queue-start|queue-delete))?$/i);
      if (match) {
        const [, id, action] = match;
        if (!validThreadId(id) || !store.thread(id, deviceId)) throw new HttpError(404, '找不到此会话');
        if (req.method === 'GET' && !action) {
          let detail = store.detail(id, deviceId), fromCache = true, refreshError;
          if (online(deviceId) && (!detail || url.searchParams.get('refresh') === '1' || Date.now() - detail.syncedAt > 4000)) {
            try { const data = await ask(deviceId, 'detail', { threadId: id }); store.saveDetail(id, data, deviceId); detail = store.detail(id, deviceId); fromCache = false; }
            catch (error) { refreshError = error.message; if (!detail) throw error; }
          }
          if (!detail) throw new HttpError(503, '电脑离线，此会话尚未缓存；请在电脑上线后打开一次');
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 80));
          const end = url.searchParams.has('before') ? Math.max(0, Math.min(detail.messages.length, Number(url.searchParams.get('before')) || 0)) : detail.messages.length;
          const start = Math.max(0, end - limit);
          const runningStale = Boolean(detail.running && online(deviceId) &&
            (refreshError || fromCache && Date.now() - detail.syncedAt > 4000));
          json(res, 200, { ...detail, messages: attachments.hydrate(deviceId, id, detail.messages.slice(start, end)),
            queue: attachments.hydrate(deviceId, id, detail.queue), total: detail.messages.length, before: start || null, fromCache,
            refreshError, runningStale, thread: store.thread(id, deviceId), ...status(deviceId) }); return;
        }
        if (req.method === 'POST' && action) {
          if (!config.controlsEnabled || agents.get(deviceId)?.controls === false) throw new HttpError(403, '当前仅允许查看会话');
          const data = await body(req);
          if (action === 'queue-delete') {
            if (typeof data.queueId !== 'string' || data.queueId.length > 100) throw new HttpError(400, '排队编号无效');
            json(res, 200, await ask(deviceId, 'queue-delete', { threadId: id, queueId: data.queueId })); return;
          }
          if (action === 'send' || action === 'queue-start') {
            if (action === 'send' && (typeof data.text !== 'string' || (!data.text.trim() && !data.attachmentIds?.length) || data.text.length > 32000) || !validThreadId(data.requestId)) throw new HttpError(400, '消息或发送编号无效');
            if (data.model != null && (typeof data.model !== 'string' || data.model.length > 200) ||
                data.effort != null && (typeof data.effort !== 'string' || data.effort.length > 32) ||
                data.mode != null && !['auto', 'steer'].includes(data.mode) ||
                data.queueId != null && (typeof data.queueId !== 'string' || data.queueId.length > 100)) throw new HttpError(400, '模型或发送选项无效');
            const previous = store.command(deviceId, data.requestId);
            if (previous) {
              if (previous.thread_id !== id) throw new HttpError(409, '发送编号已使用');
              json(res, 200, { state: previous.state, result: previous.payload ? JSON.parse(previous.payload) : null, duplicate: true }); return;
            }
            if (!online(deviceId)) throw new HttpError(503, '电脑离线，消息未发送');
            const selectedAttachments = attachments.selected(deviceId, id, data.attachmentIds);
            if (selectedAttachments.length && !status(deviceId).capabilities.attachments) throw new HttpError(409, '请先升级此电脑连接程序以接收附件');
            store.beginCommand(deviceId, data.requestId, id);
            attachments.bind(selectedAttachments.map(a => a.id), data.requestId);
            try {
              const result = await ask(deviceId, action, { threadId: id, text: data.text, requestId: data.requestId,
                model: data.model, effort: data.effort, mode: data.mode, queueId: data.queueId, attachments: selectedAttachments }, config.commandTimeoutMs || 60000,
                message => {
                  store.finishCommand(deviceId, data.requestId, message.error ? message.uncertain ? 'unknown' : 'failed' : 'accepted',
                    message.error ? { error: message.error } : message.data);
                  broadcast(deviceId, 'changed', { threadId: id });
                });
              store.finishCommand(deviceId, data.requestId, 'accepted', result);
              json(res, 200, { state: 'accepted', result });
            } catch (error) {
              store.finishCommand(deviceId, data.requestId, error.status === 504 || error.status === 503 ? 'unknown' : 'failed', { error: error.message });
              throw error;
            }
            return;
          }
          const active = status(deviceId).activeTurns.find(t => t.threadId === id);
          if (!active || (data.turnId && data.turnId !== active.turnId)) throw new HttpError(409, '任务已结束或已切换，请刷新后再停止');
          if (deviceRoute && (!data.turnId || data.connectionId !== status(deviceId).connectionId)) throw new HttpError(409, '任务状态已更新，请刷新后再停止');
          json(res, 200, await ask(deviceId, 'stop', { threadId: id, turnId: active.turnId })); return;
        }
      }
      if (req.method === 'POST' && route === '/api/approve') {
        if (!config.controlsEnabled || agents.get(deviceId)?.controls === false) throw new HttpError(403, '当前仅允许查看会话');
        const data = await body(req);
        if (typeof data.id !== 'string' || !['accept', 'decline', 'cancel'].includes(data.decision)) throw new HttpError(400, '审批参数无效');
        const approval = status(deviceId).approvals.find(p => p.id === data.id);
        if (!approval || (deviceRoute && (data.connectionId !== status(deviceId).connectionId || data.threadId !== approval.threadId))) throw new HttpError(409, '审批状态已更新，请刷新后重试');
        json(res, 200, await ask(deviceId, 'approve', { ...data, threadId: approval.threadId })); return;
      }
      throw new HttpError(404, '找不到此页面');
    } catch (error) {
      const authRequest = ['/api/login', '/api/register'].includes(new URL(req.url, 'http://localhost').pathname);
      const message = authRequest && !error.status ? '账号服务暂时不可用，请稍后重试' : error.message;
      if (!res.headersSent) json(res, error.status || 502, { error: message }); else res.end();
    }
  });
  server.requestTimeout = 75000; server.headersTimeout = 15000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const auth = req.headers.authorization, identity = auth?.startsWith('Bearer ') ? rootStore.authenticateAny(auth.slice(7)) : null;
    if (req.url !== '/agent' || req.headers.origin || !identity || accounts.access(accounts.get(identity.owner_id)) !== 'active' || (req.headers['x-device-id'] && req.headers['x-device-id'] !== identity.id)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    const deviceId = identity.id, ownerId = identity.owner_id, store = rootStore.forOwner(ownerId), previous = agents.get(deviceId);
    if (previous && online(deviceId)) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    if (previous) { disconnect(previous); previous.ws.terminate(); }
    wss.handleUpgrade(req, socket, head, ws => {
      const connection = { id: randomUUID(), ownerId, deviceId, ws, lastSeen: Date.now(), activeTurns: [], approvals: [] };
      agents.set(deviceId, connection);
      ws.send(JSON.stringify({ type: 'hello', deviceId, connectionId: connection.id }));
      ws.on('error', () => {});
      ws.on('pong', () => { connection.lastSeen = Date.now(); });
      ws.on('message', raw => {
        if (agents.get(deviceId) !== connection) return;
        if (!store.device(deviceId) || accounts.access(accounts.get(ownerId)) !== 'active') { disconnect(connection); ws.terminate(); return; }
        try {
          const msg = JSON.parse(raw.toString()); connection.lastSeen = Date.now();
          if (msg.type === 'snapshot' && Array.isArray(msg.threads) && msg.threads.length < 50000 && msg.threads.every(t => validThreadId(t.id))) {
            store.snapshot(msg.threads, msg.sidebar, deviceId); store.computerName(deviceId, msg.info?.computer);
            connection.controls = msg.info?.controls;
            connection.capabilities = msg.info?.capabilities || {}; connection.version = msg.info?.version || null;
            connection.activeTurns = Array.isArray(msg.activeTurns) ? msg.activeTurns : [];
            connection.approvals = Array.isArray(msg.approvals) ? msg.approvals : [];
            broadcast(deviceId, 'list'); directoryChanged(ownerId);
          } else if (msg.type === 'state') {
            connection.activeTurns = Array.isArray(msg.activeTurns) ? msg.activeTurns : [];
            connection.approvals = Array.isArray(msg.approvals) ? msg.approvals : [];
            broadcast(deviceId, 'status'); directoryChanged(ownerId);
          }
          else if (msg.type === 'changed') broadcast(deviceId, 'changed', { threadId: msg.threadId });
          else if (msg.type === 'response' && lateResponses.get(msg.id)?.connection === connection) {
            const late = lateResponses.get(msg.id); lateResponses.delete(msg.id);
            if (Date.now() <= late.expires) late.onLateResult(msg);
          } else if (msg.type === 'response' && pending.get(msg.id)?.connection === connection) {
            const p = pending.get(msg.id); clearTimeout(p.timer); pending.delete(msg.id);
            if (msg.error) p.reject(new HttpError(msg.uncertain ? 504 : 409, msg.error)); else p.resolve(msg.data);
          }
        } catch { /* Invalid frames never reach the browser. */ }
      });
      ws.on('close', () => disconnect(connection));
      broadcast(deviceId, 'status'); directoryChanged(ownerId);
    });
  });
  const heartbeat = setInterval(() => {
    for (const connection of agents.values()) {
      if (accounts.access(accounts.get(connection.ownerId)) !== 'active' || !online(connection.deviceId)) { disconnect(connection); connection.ws.terminate(); } else connection.ws.ping();
    }
    for (const [res, listener] of listeners) {
      const account = accounts.get(listener.ownerId);
      if (!account || account.status !== 'active' || !sessions.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(listener.sessionId, Date.now())) { res.end(); listeners.delete(res); }
      else res.write(': keepalive\n\n');
    }
    sessions.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    for (const map of [loginAttempts, pairingAttempts]) for (const [key, item] of map) if (item.until < Date.now()) map.delete(key);
    for (const [key, item] of lateResponses) if (item.expires < Date.now()) lateResponses.delete(key);
  }, 15000);
  heartbeat.unref();
  const attachmentCleanup = setInterval(() => attachmentManager.ready.then(() => attachmentManager.cleanup()).catch(() => {}), 3600000);
  attachmentCleanup.unref();
  attachmentManager.ready.then(() => attachmentManager.cleanup()).catch(() => {});
  scheduleExpiry();
  return { server, store: rootStore, accounts, status: deviceStatus, close: async () => {
    if (closing) return; closing = true; clearTimeout(expiryTimer); clearInterval(heartbeat); clearInterval(attachmentCleanup);
    for (const res of listeners.keys()) res.end();
    for (const connection of agents.values()) { disconnect(connection); connection.ws.terminate(); }
    wss.close();
    await attachmentManager.ready.catch(() => {});
    await new Promise(resolveClose => server.close(resolveClose)); rootStore.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConfig('server'), app = createApp(config);
  app.server.listen(config.port || 3819, config.host || '127.0.0.1', () => console.log(`Codex Phone server listening on ${config.host || '127.0.0.1'}:${config.port || 3819}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.close().then(() => process.exit(0)); });
}
