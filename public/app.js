/* All transcript HTML passes through DOMPurify. Credentials stay in HttpOnly cookies. */
const $ = id => document.getElementById(id);
const state = { csrf: '', username: '', primaryDeviceId: '', deviceId: '', devices: [], directoryStream: null,
  view: 'recent', threads: [], groups: [], selected: null, detail: null, status: {}, stream: null, listSeq: 0, detailSeq: 0,
  pending: null, drafts: new Map(), sending: new Set(), deviceViews: new Map(), deviceSeq: 0, directorySeq: 0,
  models: [], modelError: '', options: new Map(), projects: [], resultFilter: 'all', resultSeen: new Set(), listReady: false };
let toastTimer, searchTimer, refreshTimer, polling, runningRefreshTimer, deliveryTimer, runningRefreshAt = 0;
const scopeKey = (threadId, deviceId = state.deviceId) => `${state.username}:${deviceId}:${threadId}`;
const deviceApi = (path, data, deviceId = state.deviceId) => api(`/api/devices/${deviceId}${path}`, data);
const selectedKey = () => scopeKey(state.selected);
const deviceName = id => state.devices.find(d => d.id === id)?.name || '电脑';
function routeHash(deviceId = state.deviceId, threadId = state.selected) { return `#/devices/${deviceId}${threadId ? `/threads/${threadId}` : ''}`; }
function readRoute() {
  const match = location.hash.match(/^#\/devices\/([a-f\d-]{36})(?:\/threads\/([a-f\d-]{36}))?$/i);
  return match ? { deviceId: match[1], threadId: match[2] } : /^[a-f\d-]{36}$/i.test(location.hash.slice(1)) ? { deviceId: state.primaryDeviceId, threadId: location.hash.slice(1) } : {};
}
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function notice(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500); }
function date(value, full = false) { if (!value) return '尚未同步'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', full ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' }); }
function project(thread) { return thread.projectName || (thread.projectId ? '未命名项目' : '未关联项目'); }
function uuid() { if (crypto.randomUUID) return crypto.randomUUID(); const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const s = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`; }
async function api(path, data) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(data === undefined ? 30000 : 70000),
    ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(data) }) });
  const result = await res.json();
  if (!res.ok) { if (res.status === 401 && path !== '/api/login') showLogin(); const error = new Error(result.error || '请求失败'); error.status = res.status; throw error; }
  return result;
}
function showLogin() {
  PhoneAccounts.clear();
  $('new-thread-dialog').close(); state.resultSeen.clear(); state.listReady = false; state.projects = [];
  $('composer-settings-dialog').close(); clearTimeout(deliveryTimer);
  PhoneAttachments.reset();
  state.csrf = ''; state.stream?.close(); state.directoryStream?.close(); clearInterval(polling); clearTimeout(runningRefreshTimer); runningRefreshTimer = null; state.selected = null; state.detail = null; state.threads = []; state.listSeq++; state.detailSeq++; state.deviceSeq++; state.directorySeq++;
  state.pending = null; state.groups = []; state.drafts.clear(); state.sending.clear(); state.devices = []; state.deviceId = ''; state.deviceViews.clear();
  $('thread-list').replaceChildren(); $('messages').replaceChildren(); $('message').value = ''; $('approval-panel').replaceChildren();
  $('devices-dialog').close(); $('pair-code').textContent = ''; $('pair-result').hidden = true; $('devices-list').replaceChildren();
  state.models = []; state.options.clear(); $('execution-status').textContent = ''; $('queue-panel').hidden = true; $('delivery-status').hidden = true;
  $('app-view').classList.remove('chat-open'); $('chat').hidden = true; $('welcome').hidden = false;
  $('app-view').hidden = true; $('login-view').hidden = false; $('status-dialog').close(); $('password').value = ''; $('password').focus();
}
async function enterApp(session) {
  state.csrf = session.csrf; state.username = session.username || 'admin'; state.primaryDeviceId = session.primaryDeviceId;
  PhoneAccounts.update(session.account);
  $('login-view').hidden = true; $('app-view').hidden = false;
  $('thread-list').replaceChildren(...Array.from({ length: 4 }, () => el('div', 'skeleton')));
  await loadDevices();
  const route = readRoute(); let saved;
  try { saved = localStorage.getItem(`codex-phone-device:${state.username}`); } catch {}
  const initial = route.deviceId || saved || state.primaryDeviceId;
  const target = state.devices.some(d => d.id === initial) ? initial : route.deviceId ? null : state.devices[0]?.id;
  if (target) await switchDevice(target, false, route.threadId);
  else { renderDevices(); $('thread-list').replaceChildren(el('div', 'list-empty', route.deviceId ? '此电脑已解绑，请选择其他电脑' : '暂无电脑，请添加电脑')); }
  state.directoryStream?.close(); const directory = state.directoryStream = new EventSource('/api/devices/events');
  directory.addEventListener('devices', () => { if (state.directoryStream === directory) loadDevices().catch(() => {}); });
  directory.addEventListener('account', () => { if (state.directoryStream === directory) PhoneAccounts.refresh().catch(() => {}); });
  directory.onerror = () => { if (state.directoryStream === directory) api('/api/session').then(s => { if (!s.authenticated && state.directoryStream === directory) showLogin(); }).catch(() => {}); };
  clearInterval(polling); polling = setInterval(async () => {
    if (!state.csrf || document.hidden) return;
    const deviceId = state.deviceId;
    try { await loadDevices(); if (!deviceId) return; const data = await deviceApi('/status', undefined, deviceId);
      if (deviceId !== state.deviceId) return; updateStatus(data); if (state.selected) await loadDetail(); if (state.pending) await checkPending();
    } catch { if (deviceId === state.deviceId) markDisconnected(); }
  }, 5000);
}
async function loadDevices() {
  const seq = ++state.directorySeq, data = await api('/api/devices'); if (!state.csrf || seq !== state.directorySeq) return;
  state.primaryDeviceId = data.primaryDeviceId; state.devices = data.devices;
  PhoneAccounts.update(data.account);
  if (state.deviceId && !state.devices.some(d => d.id === state.deviceId)) {
    saveCurrentView(); state.deviceId = ''; state.stream?.close(); state.listSeq++; state.detailSeq++; state.deviceSeq++;
    state.selected = null; state.detail = null; state.status = {}; state.threads = []; state.groups = []; state.pending = null; detailBusy = false;
    $('chat').hidden = true; $('welcome').hidden = false; $('app-view').classList.remove('chat-open'); $('messages').replaceChildren();
    $('approval-panel').replaceChildren(); $('approval-panel').hidden = true;
    $('thread-list').replaceChildren(el('div', 'list-empty', '此电脑已解绑，请选择其他电脑'));
    $('thread-count').textContent = '—'; updateStatus({ online: false, activeTurns: [], approvals: [] });
  }
  renderDevices();
}
function saveCurrentView() {
  if (!state.deviceId) return;
  if (state.selected) state.drafts.set(selectedKey(), $('message').value);
  state.deviceViews.set(state.deviceId, { view: state.view, search: $('search').value, selected: state.selected, scroll: $('thread-list').scrollTop });
}
async function switchDevice(deviceId, push = true, threadId) {
  if (!state.devices.some(d => d.id === deviceId)) return;
  $('composer-settings-dialog').close(); $('send-mode').value = 'auto';
  saveCurrentView(); clearTimeout(searchTimer); clearTimeout(refreshTimer); clearTimeout(runningRefreshTimer); runningRefreshTimer = null;
  state.stream?.close(); state.listSeq++; state.detailSeq++; const seq = ++state.deviceSeq; detailBusy = false;
  state.deviceId = deviceId; state.selected = null; state.detail = null; state.pending = null; state.threads = []; state.groups = []; state.models = []; state.modelError = '';
  state.resultFilter = 'all'; state.projects = []; state.listReady = false;
  const remembered = state.deviceViews.get(deviceId);
  state.view = remembered?.view || 'recent'; $('search').value = remembered?.search || ''; state.status = {};
  $('message').value = ''; $('messages').replaceChildren(); $('approval-panel').replaceChildren(); $('approval-panel').hidden = true;
  $('chat').hidden = true; $('welcome').hidden = false; $('app-view').classList.remove('chat-open');
  $('thread-list').replaceChildren(...Array.from({ length: 3 }, () => el('div', 'skeleton')));
  $('list-title').textContent = state.view === 'recent' ? '会话' : '已归档';
  document.querySelectorAll('[data-view]').forEach(b => { const active = b.dataset.view === state.view; b.classList.toggle('active', active); if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  try { localStorage.setItem(`codex-phone-device:${state.username}`, deviceId); } catch {}
  if (push) history.pushState(null, '', routeHash(deviceId, null));
  else history.replaceState(null, '', routeHash(deviceId, threadId));
  updateStatus(state.devices.find(d => d.id === deviceId)); renderDevices(); connectEvents();
  await loadList(); if (seq !== state.deviceSeq) return;
  $('thread-list').scrollTop = remembered?.scroll || 0;
  const id = threadId ?? remembered?.selected;
  if (id && state.threads.some(t => t.id === id)) await openThread(id, false);
}
function renderDevices() {
  $('device-label').textContent = state.deviceId ? deviceName(state.deviceId) : '选择电脑';
  $('chat-device-name').textContent = state.deviceId ? deviceName(state.deviceId) : '选择电脑';
  const box = $('devices-list'), focused = box.contains(document.activeElement) ? document.activeElement.dataset.deviceFocus : null; box.replaceChildren();
  for (const device of state.devices) {
    const row = el('div', 'device-row'), button = el('button', 'device-choice');
    button.type = 'button'; button.dataset.deviceId = device.id; button.dataset.deviceFocus = `${device.id}:select`; button.setAttribute('aria-pressed', String(device.id === state.deviceId));
    const dot = el('span', `status-dot${device.online ? ' online' : ''}`), text = el('span', 'device-choice-text');
    text.append(el('strong', '', device.name), el('span', '', `${device.online ? '在线' : '离线'}${device.activeTurns?.length ? ` · ${device.activeTurns.length} 个任务` : ''} · ${date(device.lastSync, true)}`));
    button.append(dot, text); button.onclick = () => { $('devices-dialog').close(); switchDevice(device.id).catch(e => notice(e.message)); };
    const rename = el('button', 'text-button', '改名'); rename.type = 'button'; rename.dataset.deviceFocus = `${device.id}:rename`; rename.setAttribute('aria-label', `重命名 ${device.name}`);
    rename.onclick = async () => { const name = prompt('电脑名称', device.name); if (!name?.trim()) return; rename.disabled = true; try { await deviceApi('/rename', { name: name.trim() }, device.id); await loadDevices(); if (device.id === state.deviceId) updateStatus({ computer: name.trim() }); } catch (e) { notice(e.message); } finally { rename.disabled = false; } };
    const revoke = el('button', 'text-button danger-text', '解绑'); revoke.type = 'button'; revoke.dataset.deviceFocus = `${device.id}:revoke`; revoke.setAttribute('aria-label', `解绑 ${device.name}`);
    revoke.onclick = async () => { if (!confirm(`解绑“${device.name}”？这会断开连接，电脑上的任务可能仍在运行。重新接入需要新的配对码。`)) return;
      revoke.disabled = true; try { await deviceApi('/revoke', {}, device.id); await loadDevices(); notice('电脑已解绑'); } catch (e) { notice(e.message); } finally { revoke.disabled = false; } };
    row.append(button, rename, revoke); box.append(row);
  }
  if (!state.devices.length) box.append(el('p', 'device-empty', '暂无已绑定电脑'));
  if (focused && $('devices-dialog').open) [...box.querySelectorAll('[data-device-focus]')].find(node => node.dataset.deviceFocus === focused)?.focus({ preventScroll: true });
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').hidden = true; $('login-button').disabled = true;
  try { await enterApp(await api('/api/login', { username: $('username').value.trim(), password: $('password').value })); $('password').value = ''; }
  catch (error) { $('login-error').textContent = error.message; $('login-error').hidden = false; }
  finally { $('login-button').disabled = false; }
});
function markDisconnected() { $('connection-dot').classList.remove('online'); $('connection-label').textContent = '网页连接中断，正在重连'; state.status.online = false; updateComposer(); renderResultControls(); }
function updateStatus(data) {
  if (data?.deviceId && data.deviceId !== state.deviceId) return;
  const wasOnline = Boolean(state.status.online);
  state.status = { ...state.status, ...Object.fromEntries(['online', 'computer', 'lastSync', 'lastSeen', 'controls', 'activeTurns', 'approvals', 'connectionId', 'capabilities', 'connectorVersion'].filter(k => k in data).map(k => [k, data[k]])) };
  const s = state.status; $('connection-dot').classList.toggle('online', !!s.online); $('connection-label').textContent = s.online ? '电脑在线' : '电脑离线 · 可看缓存';
  if (s.online && !wasOnline && state.deviceId) void loadModels();
  renderResultControls();
  $('connection-time').textContent = s.lastSync ? `${date(s.lastSync, true)} 同步` : '等待首次同步'; $('computer-name').textContent = s.computer || '我的电脑';
  if (state.detail && !s.online) { $('cache-banner').hidden = false; $('cache-banner').textContent = `电脑已离线。正在显示 ${date(state.detail.syncedAt, true)} 的缓存记录。`; }
  if ($('status-dialog').open) renderStatus(); updateComposer(); renderApprovals(); renderTask();
}
async function loadModels() {
  const deviceId = state.deviceId, seq = state.deviceSeq; if (!deviceId) return;
  try {
    const data = await deviceApi('/models', undefined, deviceId);
    if (seq !== state.deviceSeq || deviceId !== state.deviceId) return;
    state.models = data.models || []; state.modelError = state.models.length ? '' : '连接程序未提供模型列表';
  } catch (error) { if (deviceId !== state.deviceId || seq !== state.deviceSeq) return; state.modelError = error.message; }
  renderModels();
}
function modelOptions() {
  const key = selectedKey(); if (state.options.has(key)) return state.options.get(key);
  let value = {}; try { value = JSON.parse(localStorage.getItem(`codex-phone-model:${key}`)) || {}; } catch {}
  state.options.set(key, value); return value;
}
function renderModels() {
  const choice = modelOptions(), model = $('model-select'), effort = $('effort-select'), before = document.activeElement;
  model.replaceChildren(new Option(state.detail?.settings?.model ? `跟随：${state.detail.settings.model}` : '跟随会话', ''));
  for (const item of state.models) model.append(new Option(item.name, item.id));
  if (choice.model && !state.models.some(m => m.id === choice.model)) model.append(new Option(`${choice.model}（待核验）`, choice.model));
  model.value = choice.model || '';
  effort.replaceChildren(new Option('跟随模型', ''));
  const labels = { none: '无', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: 'Ultra' };
  const selected = state.models.find(m => m.id === choice.model);
  for (const item of selected?.efforts || []) effort.append(new Option(labels[item] || item, item));
  effort.value = choice.effort || ''; updateModelControls();
  if ([model, effort].includes(before)) before.focus({ preventScroll: true });
}
function updateModelControls() {
  const steer = $('send-mode').value === 'steer' && state.status.activeTurns?.some(t => t.threadId === state.selected);
  $('model-select').disabled = Boolean(steer || !state.status.online || !state.models.length);
  $('effort-select').disabled = Boolean(steer || !state.status.online || !state.models.some(m => m.id === modelOptions().model));
  $('models-note').textContent = steer ? '补充本轮沿用正在执行的模型；切回正常 / 排队后可选择后续模型。' :
    state.modelError ? `模型列表：${state.modelError}；可用“跟随会话”发送` : '模型用于后续消息；桌面占用时，排队发送请选“跟随会话”。';
  const choice = modelOptions(), labels = { none: '无', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: 'Ultra' };
  const summary = steer ? '补充本轮' : choice.model ?
    `${state.models.find(m => m.id === choice.model)?.name || choice.model}${choice.effort ? ` · ${labels[choice.effort] || choice.effort}` : ''}` : '设置';
  $('composer-settings-label').textContent = summary;
  $('composer-settings-button').classList.toggle('has-overrides', Boolean(steer || choice.model));
  $('composer-settings-button').title = `消息设置：${summary}`;
}
for (const id of ['model-select', 'effort-select']) $(id).addEventListener('change', () => {
  const choice = { model: $('model-select').value, effort: id === 'model-select' ? '' : $('effort-select').value };
  state.options.set(selectedKey(), choice);
  try { localStorage.setItem(`codex-phone-model:${selectedKey()}`, JSON.stringify(choice)); } catch {}
  renderModels(); updateComposer();
});
function renderTask() {
  const d = state.detail, box = $('execution-status'); if (!d) { box.textContent = ''; $('queue-panel').hidden = true; return; }
  const e = d.execution || { state: d.running ? 'unconfirmed' : d.turnStatus || 'idle', lastActivityAt: d.lastActivityAt };
  const labels = { running: '正在执行，可继续排队或补充本轮', completed: '上一轮已完成，可以继续',
    interrupted: '上一轮已中断，可以继续；中断不一定产生最终回复', failed: '上一轮失败，可以继续',
    idle: '当前空闲，可以继续', unconfirmed: '未确认任务是否仍在执行；可以提交下一条，桌面占用时会排队' };
  const stateLabel = !state.status.online ? '电脑离线；仍可编辑草稿' : labels[e.state] || '任务状态待核对，可以编辑下一条';
  box.textContent = `${stateLabel}${e.lastActivityAt ? ` · 最近活动 ${date(e.lastActivityAt, true)}` : ''}${e.error ? ` · ${e.error}` : ''}`;
  box.classList.toggle('warning', ['unconfirmed', 'failed', 'interrupted'].includes(e.state));
  const queue = d.queue || []; $('queue-panel').hidden = !queue.length;
  $('queue-summary').textContent = `${queue.length} 条待执行消息（尚未完成）`;
  const fragment = document.createDocumentFragment();
  for (const item of queue) {
    const row = el('div', 'queue-item'); row.append(el('p', '', item.text?.slice(0, 300) || '已提交的消息'));
    const cancel = el('button', 'text-button', '取消排队'); cancel.type = 'button'; cancel.disabled = !state.status.online || !state.status.controls;
    const deviceId = state.deviceId, threadId = state.selected;
    cancel.onclick = async () => { cancel.disabled = true; try { await deviceApi(`/threads/${threadId}/queue-delete`, { queueId: item.id }, deviceId);
      if (deviceId === state.deviceId && threadId === state.selected) await loadDetail(true); } catch (error) { notice(error.message); cancel.disabled = false; } };
    row.append(cancel); if (item.attachments?.length) row.append(PhoneAttachments.cards(item.attachments)); fragment.append(row);
  }
  if (queue.length) {
    const start = el('button', 'text-button', '尝试执行队首'); start.type = 'button'; start.disabled = !state.status.online || !state.status.controls || Boolean(d.execution?.owned);
    const deviceId = state.deviceId, threadId = state.selected;
    start.onclick = async () => { start.disabled = true; try {
      await deviceApi(`/threads/${threadId}/queue-start`, { queueId: queue[0].id, requestId: uuid() }, deviceId);
      if (deviceId === state.deviceId && threadId === state.selected) await loadDetail(true);
    } catch (error) { notice(error.message); } finally { start.disabled = false; } };
    fragment.append(start);
  }
  $('queue-list').replaceChildren(fragment);
}
function renderStatus() {
  const s = state.status; $('status-detail').replaceChildren(...[['电脑', s.computer || '尚未连接'], ['状态', s.online ? '在线' : '离线'], ['最近同步', date(s.lastSync, true)], ['操作权限', s.controls ? '可续聊与停止手机任务' : '仅查看'], ['运行中的手机任务', String((s.activeTurns || []).length)]].map(([k, v]) => { const row = el('div', 'status-item'); row.append(el('span', '', k), el('span', '', v)); return row; }));
}
function connectEvents() {
  state.stream?.close(); const deviceId = state.deviceId, stream = state.stream = new EventSource(`/api/devices/${deviceId}/events`);
  const current = () => state.deviceId === deviceId && state.stream === stream;
  stream.addEventListener('list', () => { if (current()) loadList(); });
  stream.addEventListener('status', async () => { try { const data = await deviceApi('/status', undefined, deviceId); if (current()) updateStatus(data); } catch { if (current()) markDisconnected(); } });
  stream.addEventListener('changed', event => { if (!current()) return; const data = JSON.parse(event.data); if (data.threadId === state.selected) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (current()) loadDetail(true); }, 800); } });
  stream.addEventListener('revoked', () => { if (current()) loadDevices().catch(() => {}); });
  stream.onerror = () => { if (current()) markDisconnected(); };
}
async function loadList() {
  if (!state.deviceId) return;
  const seq = ++state.listSeq, deviceId = state.deviceId;
  try {
    const data = await deviceApi(`/threads?archived=${state.view === 'archived'}&q=${encodeURIComponent($('search').value)}`, undefined, deviceId);
    if (seq !== state.listSeq || deviceId !== state.deviceId) return;
    syncResultNotice(state.threads, data.threads); state.threads = data.threads; state.projects = data.sidebar?.projects || [];
    state.groups = data.groups || [{ id: 'unassigned', name: '会话', kind: 'chats', expanded: true, threadIds: data.threads.map(t => t.id) }]; $('list-error').hidden = true;
    $('thread-count').textContent = $('search').value ? data.threads.length : state.view === 'archived' ? data.archivedCount : data.total;
    updateStatus(data); renderList();
  } catch (error) { if (seq !== state.listSeq) return; $('list-error').textContent = `${error.message}。点击右上角刷新重试。`; $('list-error').hidden = false; if (!state.threads.length) $('thread-list').replaceChildren(el('div', 'list-empty', '暂时无法读取会话')); }
}
function groupExpanded(group) {
  if (group.kind === 'results') return true;
  if ($('search').value.trim()) return true;
  try { const value = localStorage.getItem(`codex-phone-group:${scopeKey(state.view)}:${group.id}`); if (value !== null) return value === 'true'; } catch {}
  return group.expanded;
}
function setGroupExpanded(id, expanded) {
  const group = state.groups.find(g => g.id === id); if (group) group.expanded = expanded;
  try { localStorage.setItem(`codex-phone-group:${scopeKey(state.view)}:${id}`, String(expanded)); } catch {}
}
function groupIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS(svg.namespaceURI, 'path');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('d', kind === 'project' ? 'M3 7V5h6l2 2h10v12H3Z' : kind === 'pinned' ? 'm16 3 5 5-3 1-3 5v3l-4-4-6 6m3-9h3l5-4Z' : kind === 'chevron' ? 'm9 5 7 7-7 7' : 'M4 4h16v12H9l-5 4Z');
  svg.append(path); return svg;
}
function renderList() {
  const fragment = document.createDocumentFragment(), byId = new Map(state.threads.map(t => [t.id, t]));
  const focused = document.activeElement?.closest('[data-group-id]')?.dataset.groupId;
  const visibleGroups = resultGroups(); renderResultControls();
  for (const [index, group] of visibleGroups.entries()) {
    const expanded = groupExpanded(group), section = el('section', 'thread-group'), heading = el('h2', 'group-heading');
    const toggle = el('button', 'group-toggle'), body = el('div', 'group-threads');
    toggle.type = 'button'; toggle.dataset.groupId = group.id; toggle.setAttribute('aria-expanded', String(expanded));
    toggle.disabled = Boolean($('search').value.trim());
    body.id = `thread-group-${index}`; body.hidden = !expanded; toggle.setAttribute('aria-controls', body.id);
    toggle.append(groupIcon('chevron'), groupIcon(group.kind), el('span', 'group-name', group.name), el('span', 'group-count', String(group.threadIds.length)));
    heading.append(toggle); section.append(heading, body); fragment.append(section);
    for (const id of group.threadIds) {
      const thread = byId.get(id); if (!thread) continue;
    const row = el('button', `thread-row${state.selected === thread.id ? ' selected' : ''}`); row.type = 'button'; row.dataset.threadId = thread.id;
    row.setAttribute('aria-pressed', String(state.selected === thread.id)); const top = el('span', 'thread-top'); top.append(el('span', 'thread-title', thread.title), el('time', 'thread-time', date(thread.updatedAt)));
      row.append(top, el('span', 'thread-preview', thread.preview?.replace(/\s+/g, ' ') || '打开查看聊天记录'));
      if (group.kind !== 'project') row.append(el('span', 'thread-project', project(thread)));
      appendResultStatus(row, thread); body.append(row);
    }
    if (!group.threadIds.length) body.append(el('p', 'group-empty', '此项目暂无会话'));
  }
  if (!visibleGroups.length) { const empty = el('div', 'list-empty'); empty.append(el('strong', '', state.resultFilter === 'unread' ? '新结果都已查看' : $('search').value ? '没有找到匹配会话' : '这里还没有会话'), el('p', '', state.resultFilter === 'unread' ? '新回复出现后会自动显示在这里；首次使用展示最近 24 小时的结果。' : $('search').value ? '换个关键词，或搜索项目名称。' : state.status.online ? '点右上角加号，新建第一个对话。' : '请在电脑上启动连接程序。')); fragment.append(empty); }
  const scroll = $('thread-list').scrollTop; $('thread-list').replaceChildren(fragment); $('thread-list').scrollTop = scroll;
  if (focused) [...$('thread-list').querySelectorAll('[data-group-id]')].find(e => e.dataset.groupId === focused)?.focus({ preventScroll: true });
  const count = state.groups.filter(g => g.kind === 'project').length;
  $('group-summary').textContent = count ? `${count} 个项目${$('search').value.trim() ? ' · 搜索结果' : ''}` : '会话分类';
  $('collapse-groups').disabled = state.resultFilter === 'unread' || !state.groups.length || Boolean($('search').value.trim());
  $('collapse-groups').textContent = state.groups.some(groupExpanded) ? '全部收起' : '全部展开';
}
$('collapse-groups').addEventListener('click', () => { const expanded = !state.groups.some(groupExpanded); state.groups.forEach(g => setGroupExpanded(g.id, expanded)); renderList(); });
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 180); });
$('thread-list').addEventListener('click', event => {
  const toggle = event.target.closest('[data-group-id]');
  if (toggle) { if ($('search').value.trim()) return; setGroupExpanded(toggle.dataset.groupId, toggle.getAttribute('aria-expanded') !== 'true'); renderList(); return; }
  const row = event.target.closest('[data-thread-id]'); if (row) openThread(row.dataset.threadId);
});
async function openThread(id, push = true) {
  if (!state.deviceId) return;
  $('composer-settings-dialog').close(); $('send-mode').value = 'auto';
  if (state.selected) state.drafts.set(selectedKey(), $('message').value);
  const group = state.groups.find(g => g.threadIds.includes(id)); if (group && !groupExpanded(group)) setGroupExpanded(group.id, true);
  state.selected = id; state.detail = null; state.detailSeq++; detailBusy = false; state.pending = readPending(id); $('message').value = state.drafts.get(selectedKey()) || '';
  $('app-view').classList.add('chat-open'); $('welcome').hidden = true; $('chat').hidden = false; $('cache-banner').hidden = true;
  $('chat-title').textContent = state.threads.find(t => t.id === id)?.title || '正在打开会话'; $('chat-project').textContent = ''; $('messages').replaceChildren(el('div', 'list-empty', '正在读取聊天记录…'));
  if (push) history.pushState({ thread: id }, '', routeHash());
  else history.replaceState(null, '', routeHash());
  $('delivery-status').hidden = true; renderModels(); renderList(); updateComposer(); await loadDetail(true, true);
}
function backToList() { $('composer-settings-dialog').close(); if (state.selected) state.drafts.set(selectedKey(), $('message').value); state.selected = null; state.detail = null; state.detailSeq++; detailBusy = false; state.pending = null; $('app-view').classList.remove('chat-open'); $('chat').hidden = true; $('welcome').hidden = false; renderList(); }
window.addEventListener('popstate', () => {
  const route = readRoute();
  if (route.deviceId && route.deviceId !== state.deviceId) switchDevice(route.deviceId, false, route.threadId).catch(e => notice(e.message));
  else if (route.threadId) openThread(route.threadId, false);
  else backToList();
});
let detailBusy = false;
async function loadDetail(force = false, initial = false) {
  const id = state.selected, deviceId = state.deviceId; if (!id || (!force && detailBusy)) return;
  const seq = ++state.detailSeq; detailBusy = true; if (initial) $('messages').setAttribute('aria-busy', 'true');
  try {
    const data = await deviceApi(`/threads/${id}?limit=80${force ? '&refresh=1' : ''}`, undefined, deviceId);
    if (seq !== state.detailSeq || id !== state.selected || deviceId !== state.deviceId) return;
    const old = state.detail;
    if (old && old.transcriptVersion === data.transcriptVersion && old.total <= data.total) {
      // Refresh the tail while retaining all contiguous history already loaded.
      const tailStart = data.total - data.messages.length, oldStart = old.total - old.messages.length;
      if (tailStart <= old.total) { data.messages = [...old.messages.slice(0, Math.max(0, tailStart - oldStart)), ...data.messages]; data.before = oldStart || null; }
    }
    const changed = !old || JSON.stringify(old.messages) !== JSON.stringify(data.messages);
    state.detail = data; updateStatus(data); $('chat-title').textContent = data.thread.title; $('chat-project').textContent = `${project(data.thread)}${data.thread.model ? ` · ${data.thread.model}` : ''}`;
    const cached = !data.online || data.refreshError;
    $('cache-banner').hidden = !cached; $('cache-banner').textContent = data.refreshError || `电脑已离线。正在显示 ${date(data.syncedAt, true)} 的缓存记录。`;
    if (changed || initial) renderMessages(initial); if (initial) renderModels(); updateComposer(); renderTask(); markResultRead();
  } catch (error) {
    if (seq !== state.detailSeq || id !== state.selected || deviceId !== state.deviceId) return;
    if (!state.detail) { const empty = el('div', 'list-empty'); const retry = el('button', 'secondary', '重新读取'); retry.onclick = () => loadDetail(true, true); empty.append(el('p', '', error.message), retry); $('messages').replaceChildren(empty); }
    else { $('cache-banner').hidden = false; $('cache-banner').textContent = `刷新失败：${error.message}`; }
  } finally { if (seq === state.detailSeq) { detailBusy = false; $('messages').setAttribute('aria-busy', 'false'); } }
}
function renderMessages(initial = false, prepended = false) {
  const box = $('messages'), beforeHeight = box.scrollHeight, beforeTop = box.scrollTop, nearBottom = beforeHeight - beforeTop - box.clientHeight < 120;
  const fragment = document.createDocumentFragment(), detail = state.detail;
  if (detail.before != null) { const wrap = el('div', 'older-wrap'), button = el('button', 'secondary', '加载更早的消息'); button.onclick = () => older(button); wrap.append(button); fragment.append(wrap); }
  for (const message of detail.messages) {
    if (message.role !== 'user' && !(message.role === 'assistant' && message.phase === 'final_answer')) continue;
    const article = el('article', `message ${message.role}`), meta = el('div', 'message-meta'), body = el('div', 'message-body');
    article.setAttribute('aria-label', message.role === 'user' ? '你的消息' : 'Codex 回复');
    meta.append(el('span', 'message-role', message.role === 'user' ? '你 · 发送' : 'Codex · 回复'), el('time', 'message-time', date(message.time, true)));
    if (message.role === 'assistant') {
      body.innerHTML = DOMPurify.sanitize(marked.parse(message.text || '', { breaks: true }), { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'picture', 'video', 'audio', 'source', 'iframe', 'style', 'form', 'input', 'button', 'textarea'], FORBID_ATTR: ['style', 'src', 'srcset', 'id', 'name'] });
      body.querySelectorAll('a').forEach(a => { if (!/^https?:\/\//i.test(a.getAttribute('href') || '')) { a.removeAttribute('href'); } else { a.target = '_blank'; a.rel = 'noopener noreferrer'; } });
    } else { body.textContent = message.text; body.hidden = !message.text?.trim(); }
    article.append(meta, body); if (message.role === 'user' && message.attachments?.length) article.append(PhoneAttachments.cards(message.attachments)); fragment.append(article);
  }
  if (!detail.messages.length) fragment.append(el('div', 'list-empty', '这段会话还没有聊天记录。'));
  box.replaceChildren(fragment);
  if (prepended) box.scrollTop = beforeTop + box.scrollHeight - beforeHeight;
  else if (initial || nearBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = beforeTop;
}
async function older(button) {
  const id = state.selected, deviceId = state.deviceId, seq = state.deviceSeq, cursor = state.detail?.before; if (cursor == null) return; button.disabled = true;
  try { const data = await deviceApi(`/threads/${id}?limit=80&before=${cursor}`, undefined, deviceId); if (deviceId !== state.deviceId || seq !== state.deviceSeq || id !== state.selected || state.detail?.before !== cursor) return; if (data.transcriptVersion !== state.detail.transcriptVersion) { await loadDetail(true, true); return; } state.detail.messages = [...data.messages, ...state.detail.messages]; state.detail.before = data.before; renderMessages(false, true); }
  catch (error) { notice(error.message); button.disabled = false; }
}
function resizeComposer() {
  const input = $('message'), box = $('messages'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!input.getClientRects().length) { input.style.height = ''; return; }
  const maximum = parseFloat(getComputedStyle(input).maxHeight) || 128;
  input.style.height = '44px';
  input.style.height = `${Math.min(maximum, Math.max(44, input.scrollHeight))}px`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function updateViewport() {
  const viewport = window.visualViewport;
  if (viewport && viewport.scale === 1) document.documentElement.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
  else document.documentElement.style.removeProperty('--app-height');
  resizeComposer();
}
window.addEventListener('resize', updateViewport);
window.visualViewport?.addEventListener('resize', updateViewport);
updateViewport();
function updateComposer() {
  const d = state.detail, s = state.status, owned = s.activeTurns?.some(t => t.threadId === state.selected), sending = state.sending.has(selectedKey());
  const staleRunning = Boolean(d?.running && s.online && !owned &&
    (d.runningStale || d.refreshError || (d.fromCache && Date.now() - Number(d.syncedAt || 0) > 4000)));
  if (staleRunning && !runningRefreshTimer && Date.now() - runningRefreshAt > 5000) {
    const id = state.selected, deviceId = state.deviceId;
    runningRefreshAt = Date.now();
    runningRefreshTimer = setTimeout(() => {
      runningRefreshTimer = null;
      if (id === state.selected && deviceId === state.deviceId && state.detail?.running && state.status.online) loadDetail(true).catch(() => {});
    }, 250);
  }
  const attachmentIds = PhoneAttachments.ids();
  const entries = readPendingEntries(state.selected), duplicate = entries.some(p => typeof p.submitted === 'string' &&
    PhoneAttachments.identity(p.submitted, p.attachmentIds) === PhoneAttachments.identity($('message').value, attachmentIds));
  let reason = !PhoneAccounts.active() ? '套餐已到期，请在账户页查看续期说明；草稿可以继续写' : !d ? '正在读取会话' : !s.online ? '电脑离线，联网后才能发送；草稿可以继续写' : !s.controls ? '当前为只读模式' : d.thread.archived ? '已归档，请先在桌面恢复会话' : !d.thread.local ? '此会话不在本机，只能查看' : sending ? '正在提交…' : duplicate ? '相同消息结果待确认，先核对，避免重复执行' : '';
  // A running/unknown/offline turn must never prevent writing the next draft.
  // Submission is checked separately so drafting does not imply permission to execute.
  $('message').disabled = !state.selected;
  $('send-button').disabled = Boolean(reason || (!$('message').value.trim() && !attachmentIds.length) || PhoneAttachments.blocked()); $('stop-button').hidden = !owned; $('stop-button').disabled = !s.online || !s.controls;
  PhoneAttachments.render();
  $('send-mode').querySelector('[value="steer"]').disabled = !owned;
  if (!owned && $('send-mode').value === 'steer') $('send-mode').value = 'auto';
  const sendLabel = sending ? '正在提交消息' : $('send-mode').value === 'steer' && owned ? '补充本轮' : owned || d?.running ? '排队发送' : '发送消息';
  $('send-label').textContent = sendLabel; $('send-button').setAttribute('aria-label', sendLabel); $('send-button').title = sendLabel;
  updateModelControls();
  $('composer-status').replaceChildren();
  $('composer-status').hidden = !reason && !entries.length;
  if (reason || entries.length) $('composer-status').append(el('span', '', reason || `${entries.length} 条提交待核对，仍可发送不同的新消息。`));
  if (state.pending) { const b = el('button', 'text-button', '核对发送状态'); b.type = 'button'; b.onclick = async () => { const key = selectedKey(); await checkPending(); if (key === selectedKey() && state.pending && confirm('请先刷新并核对聊天记录。解除保护后再次发送，可能重复执行尚未确认的指令。已确认上一条的执行情况？')) { clearPending(); updateComposer(); } }; $('composer-status').append(b); }
  $('chat-badge').textContent = owned ? '执行中' : d?.running ? '待核对' : d?.thread.archived ? '已归档' : '会话'; $('chat-badge').classList.toggle('running', !!owned);
  resizeComposer();
}
function renderApprovals() {
  const deviceId = state.deviceId, connectionId = state.status.connectionId, seq = state.deviceSeq;
  const approvals = (state.status.approvals || []).filter(p => p.threadId === state.selected); const panel = $('approval-panel'); panel.hidden = !approvals.length; panel.replaceChildren();
  for (const p of approvals) { const item = el('div'); item.append(el('strong', '', p.type === 'command' ? 'Codex 请求执行命令' : 'Codex 请求修改文件'), el('p', '', p.reason)); if (p.command || p.cwd) item.append(el('pre', '', [p.command, p.cwd].filter(Boolean).join('\n')));
    const buttons = el('div', 'approval-buttons'); for (const [decision, label] of [['accept', '允许本次'], ['decline', '拒绝'], ['cancel', '取消任务']]) { const b = el('button', decision === 'accept' ? 'primary' : 'secondary', label); b.disabled = !state.status.online || !state.status.controls; b.onclick = async () => {
      if (deviceId !== state.deviceId || seq !== state.deviceSeq) return;
      b.disabled = true; try { await deviceApi('/approve', { id: p.id, threadId: p.threadId, connectionId, decision }, deviceId);
        const data = await deviceApi('/status', undefined, deviceId); if (deviceId === state.deviceId && seq === state.deviceSeq) updateStatus(data);
      } catch (e) { notice(`${deviceName(deviceId)}：${e.message}`); b.disabled = false; } }; buttons.append(b); } item.append(buttons); panel.append(item);
  }
}
function readPendingEntries(id, deviceId = state.deviceId) {
  try {
    const key = `codex-phone-pending:${scopeKey(id, deviceId)}`;
    let value = localStorage.getItem(key);
    const parsed = JSON.parse(value); return parsed ? Array.isArray(parsed) ? parsed : [parsed] : [];
  } catch { return []; }
}
function readPending(id, deviceId = state.deviceId) { return readPendingEntries(id, deviceId)[0] || null; }
function clearPending(id = state.selected, deviceId = state.deviceId, requestId) {
  try {
    const remaining = requestId ? readPendingEntries(id, deviceId).filter(p => p.id !== requestId) : [];
    if (remaining.length) localStorage.setItem(`codex-phone-pending:${scopeKey(id, deviceId)}`, JSON.stringify(remaining));
    else localStorage.removeItem(`codex-phone-pending:${scopeKey(id, deviceId)}`);
  } catch {}
  if (id === state.selected && deviceId === state.deviceId) state.pending = readPending(id, deviceId);
}
function delivery(result, warning = false) {
  clearTimeout(deliveryTimer);
  $('delivery-status').hidden = false; $('delivery-status').classList.toggle('warning', warning); $('delivery-status').textContent = result;
  if (!warning) deliveryTimer = setTimeout(() => { $('delivery-status').hidden = true; }, 6000);
}
function deliveryText(result) { return result?.queued ? '已进入队列，等待执行；可继续发送。' :
  result?.delivery === 'steered' ? '已补充本轮，可继续发送。' : '电脑已接收，正在处理；可继续发送。'; }
async function checkPending() {
  const id = state.selected, deviceId = state.deviceId, seq = state.deviceSeq;
  const entries = readPendingEntries(id, deviceId); if (!entries.length && state.pending) entries.push(state.pending);
  const results = await Promise.all(entries.slice(0, 20).map(async p => {
    try { return { p, data: await deviceApi(`/commands/${p.id}`, undefined, deviceId) }; } catch { return { p }; }
  }));
  if (id !== state.selected || deviceId !== state.deviceId || seq !== state.deviceSeq) return;
  let refresh = false;
  for (const { p, data } of results) {
    if (data?.state === 'accepted') {
      PhoneAttachments.accepted(id, deviceId, p.attachmentIds);
      clearPending(id, deviceId, p.id);
      if (typeof p.submitted === 'string' && $('message').value === p.submitted) { $('message').value = ''; if (state.drafts.get(selectedKey()) === p.submitted) state.drafts.delete(selectedKey()); }
      delivery(deliveryText(data.result)); refresh = true;
    } else if (data?.state === 'failed') { clearPending(id, deviceId, p.id); delivery(data.result?.error || '消息未执行，可以重新发送', true); }
  }
  updateComposer(); if (refresh) await loadDetail(true);
}
$('message').addEventListener('input', updateComposer);
$('send-mode').addEventListener('change', updateComposer);
$('message').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!$('send-button').disabled) $('composer').requestSubmit(); } });
$('composer').addEventListener('submit', async event => {
  event.preventDefault(); if ($('send-button').disabled) return;
  const id = state.selected, deviceId = state.deviceId, key = selectedKey(), submitted = $('message').value, text = submitted.trim(), requestId = uuid();
  const attachmentIds = PhoneAttachments.ids();
  const choice = modelOptions(), mode = $('send-mode').value,
    options = { ...(choice.model && mode !== 'steer' ? { model: choice.model, effort: choice.effort || undefined } : {}), mode };
  const receipt = { id: requestId, submitted, attachmentIds, createdAt: Date.now() };
  state.sending.add(key); state.drafts.set(key, submitted);
  try { localStorage.setItem(`codex-phone-pending:${key}`, JSON.stringify([...readPendingEntries(id, deviceId), receipt])); } catch {}
  state.pending = readPending(id, deviceId) || receipt; delivery('正在提交到电脑；此时可以继续编辑下一条。'); updateComposer();
  try { const result = await deviceApi(`/threads/${id}/send`, { text, requestId, attachmentIds, ...options }, deviceId);
    if (result.state === 'accepted') {
      clearPending(id, deviceId, requestId);
      PhoneAttachments.accepted(id, deviceId, attachmentIds);
      if (state.drafts.get(key) === submitted) state.drafts.delete(key);
      if (id === state.selected && deviceId === state.deviceId) { if ($('message').value === submitted) $('message').value = ''; await loadDetail(true); }
      if (id === state.selected && deviceId === state.deviceId) delivery(deliveryText(result.result));
      notice(`${deviceName(deviceId)}：${result.result?.queued ? '已进入桌面队列' : result.result?.delivery === 'steered' ? '已补充本轮' : '已接收'}`);
    } else notice(`${deviceName(deviceId)}：发送结果暂未确认，请核对聊天记录`);
  } catch (error) {
    if (error.status && error.status < 500) clearPending(id, deviceId, requestId);
    const message = error.status ? error.message : '网络中断或提交超时；这条消息是否执行尚未确认。可以编辑不同的新消息，请勿重复发送原消息。';
    if (id === state.selected && deviceId === state.deviceId) delivery(message, true); notice(`${deviceName(deviceId)}：${message}`);
  }
  finally { state.sending.delete(key); updateComposer(); }
});
document.addEventListener('click', async event => {
  const view = event.target.closest('[data-view]');
  if (view) { state.view = view.dataset.view; $('list-title').textContent = state.view === 'recent' ? '会话' : '已归档'; $('thread-list').replaceChildren(...Array.from({ length: 3 }, () => el('div', 'skeleton'))); document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === state.view); if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }); await loadList(); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  try {
    switch (button.dataset.action) {
      case 'back': history.replaceState(null, '', routeHash(state.deviceId, null)); backToList(); break;
      case 'devices': await loadDevices(); $('devices-dialog').showModal(); break;
      case 'pair': {
        button.disabled = true;
        const result = await api('/api/device-pairings', {});
        $('pair-code').textContent = result.code; $('pair-expiry').textContent = `有效至 ${new Date(result.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
        $('pair-result').hidden = false; break;
      }
      case 'copy-pair': await navigator.clipboard.writeText($('pair-code').textContent); notice('配对码已复制'); break;
      case 'status': renderStatus(); $('status-dialog').showModal(); break;
      case 'account': PhoneAccounts.show(); break;
      case 'composer-settings': updateModelControls(); $('composer-settings-dialog').showModal(); break;
      case 'refresh': button.disabled = true; await loadList(); if (state.selected) await loadDetail(true); notice('已刷新'); break;
      case 'logout': await api('/api/logout', {}); history.replaceState(null, '', location.pathname); showLogin(); break;
      case 'stop': {
        const deviceId = state.deviceId, threadId = state.selected, turnId = state.status.activeTurns?.find(t => t.threadId === threadId)?.turnId;
        button.disabled = true; await deviceApi(`/threads/${threadId}/stop`, { turnId, connectionId: state.status.connectionId }, deviceId);
        notice(`${deviceName(deviceId)}：已请求停止任务`); if (deviceId === state.deviceId && threadId === state.selected) await loadDetail(true); break;
      }
    }
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.csrf) { loadList(); if (state.selected) loadDetail(true); } });
PhoneAccounts.mount({ api, el, notice, enterApp, showLogin, updateComposer, getState: () => state });
const invited = PhoneAccounts.prepareInvite();
api('/api/session').then(session => !invited && session.authenticated ? enterApp(session) : showLogin()).catch(() => { showLogin(); $('login-error').textContent = '暂时无法连接服务器，请刷新重试。'; $('login-error').hidden = false; });
