/* Results are scoped to account/device/thread and stored on this browser only. */
function resultBaseline() {
  const key = `codex-phone-result-baseline:${scopeKey('results')}`;
  try {
    const prior = Number(localStorage.getItem(key));
    if (prior > 0) return prior;
    const value = Date.now() - 86400000;
    localStorage.setItem(key, String(value)); return value;
  } catch { return Date.now() - 86400000; }
}
function hasUnreadResult(thread) {
  const activity = thread.activity;
  if (!activity?.resultKey || !activity.resultAt || activity.resultAt < resultBaseline()) return false;
  if (state.resultSeen.has(`${scopeKey(thread.id)}:${activity.resultKey}`)) return false;
  try { return localStorage.getItem(`codex-phone-result-seen:${scopeKey(thread.id)}`) !== activity.resultKey; }
  catch { return !state.resultSeen.has(`${scopeKey(thread.id)}:${activity.resultKey}`); }
}
function resultState(thread) {
  if (state.status.activeTurns?.some(t => t.threadId === thread.id)) return { text: '正在执行', kind: 'running' };
  const value = thread.activity?.state;
  const states = { completed: ['已完成', 'completed'], interrupted: ['已中断', 'warning'], failed: ['失败', 'warning'],
    unconfirmed: ['执行状态未确认', 'neutral'], idle: ['空闲', 'neutral'] };
  const [text, kind] = states[value] || ['状态未确认', 'neutral'];
  return { text, kind };
}
function resultGroups() {
  if (state.resultFilter !== 'unread' || state.view === 'archived') return state.groups;
  const ids = state.threads.filter(hasUnreadResult).sort((a, b) => b.activity.resultAt - a.activity.resultAt).map(t => t.id);
  return ids.length ? [{ id: 'new-results', kind: 'results', name: '未读结果 · 最新在前', expanded: true, threadIds: ids }] : [];
}
function renderResultControls() {
  const count = state.threads.filter(t => !t.archived && hasUnreadResult(t)).length;
  $('unread-count').textContent = String(count);
  $('result-filters').hidden = state.view === 'archived';
  document.querySelectorAll('[data-result-filter]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.resultFilter === state.resultFilter));
  });
  const supported = state.status.capabilities?.createThread;
  $('new-thread-button').disabled = !state.deviceId || !state.status.online || !state.status.controls;
  $('new-thread-button').title = supported ? '新建对话' : '此电脑需更新连接程序才能新建';
}
function appendResultStatus(row, thread) {
  const status = resultState(thread), box = el('span', 'thread-result-status');
  if (hasUnreadResult(thread)) { box.append(el('span', 'result-badge unread', '有新结果')); row.classList.add('has-unread-result'); }
  box.append(el('span', `result-badge ${status.kind}`, status.text));
  if (thread.activity?.resultAt) box.append(el('time', '', `回复 ${date(thread.activity.resultAt, true)}`));
  row.append(box);
}
function markResultRead() {
  const thread = state.threads.find(t => t.id === state.selected), activity = thread?.activity, box = $('messages');
  if (!hasUnreadResult(thread || {}) || document.hidden || $('chat').hidden ||
      box.scrollHeight - box.scrollTop - box.clientHeight > 120) return;
  const finals = (state.detail?.messages || []).filter(m => m.role === 'assistant' && m.phase === 'final_answer');
  if (!finals.some(m => Date.parse(m.time) >= activity.resultAt - 1000)) return;
  try { localStorage.setItem(`codex-phone-result-seen:${scopeKey(thread.id)}`, activity.resultKey); } catch {}
  state.resultSeen.add(`${scopeKey(thread.id)}:${activity.resultKey}`); renderList();
}
function syncResultNotice(previous, incoming) {
  if (!state.listReady) { state.listReady = true; return; }
  const old = new Map(previous.map(t => [t.id, t.activity?.resultKey]));
  const fresh = incoming.filter(t => t.activity?.resultAt >= Date.now() - 60000 &&
    t.activity.resultKey && t.activity.resultKey !== old.get(t.id) && hasUnreadResult(t));
  if (fresh.length && !document.hidden) notice(`${fresh.length} 个会话有新结果，点“未读结果”查看`);
}
document.querySelectorAll('[data-result-filter]').forEach(button => button.addEventListener('click', () => {
  state.resultFilter = button.dataset.resultFilter; renderList(); $('thread-list').scrollTop = 0;
}));
document.getElementById('messages').addEventListener('scroll', () => markResultRead(), { passive: true });

function creationReceiptKey(deviceId = state.deviceId) { return `codex-phone-create:${scopeKey('new', deviceId)}`; }
function showCreateDialog() {
  if (!state.status.online || !state.status.controls) { notice('请先连接有操作权限的电脑'); return; }
  if (!state.status.capabilities?.createThread) { notice('请先把这台电脑的连接程序更新到 0.5.0，设备身份无需重新配对'); return; }
  const dialog = $('new-thread-dialog'); dialog.dataset.deviceId = state.deviceId;
  $('new-thread-computer').textContent = `创建到：${deviceName(state.deviceId)}`;
  const select = $('new-thread-project'), options = [];
  for (const p of state.projects) for (const root of p.rootPaths || []) options.push({
    projectId: p.id, rootPath: root, label: `${p.name}${p.rootPaths.length > 1 ? ` · ${root}` : ''}`
  });
  options.push({ projectId: null, rootPath: null, label: '无项目（独立工作区）' });
  select.replaceChildren(...options.map((option, index) => { const node = new Option(option.label, JSON.stringify({ projectId: option.projectId, rootPath: option.rootPath })); node.selected = index === 0; return node; }));
  const current = state.threads.find(t => t.id === state.selected)?.projectId;
  if (current) for (const node of select.options) if (JSON.parse(node.value).projectId === current) { node.selected = true; break; }
  $('new-thread-name').value = ''; $('new-thread-error').hidden = true;
  $('create-thread-submit').textContent = '创建并打开'; $('create-thread-submit').disabled = false;
  dialog.showModal();
  if (!state.resultFilter) state.resultFilter = 'all';
}
document.getElementById('new-thread-button').addEventListener('click', showCreateDialog);
document.getElementById('new-thread-form').addEventListener('submit', async event => {
  event.preventDefault();
  const deviceId = $('new-thread-dialog').dataset.deviceId, button = $('create-thread-submit');
  if (button.disabled) return;
  button.disabled = true; $('new-thread-error').hidden = true;
  let receipt;
  try { receipt = JSON.parse(localStorage.getItem(creationReceiptKey(deviceId)) || 'null'); } catch {}
  receipt ||= $('new-thread-dialog').createReceipt?.deviceId === deviceId ? $('new-thread-dialog').createReceipt.data : null;
  try {
    let response;
    if (receipt) {
      response = await deviceApi(`/commands/${receipt.requestId}`, undefined, deviceId);
      if (response.state === 'not_found') {
        // Only re-submit the same immutable request when the server has no record.
        response = await deviceApi('/threads', receipt, deviceId);
      }
    } else {
      receipt = { requestId: uuid(), title: $('new-thread-name').value.trim(), ...JSON.parse($('new-thread-project').value) };
      // If storage is unavailable, retain the receipt on the dialog for retries.
      try { localStorage.setItem(creationReceiptKey(deviceId), JSON.stringify(receipt)); }
      catch { $('new-thread-dialog').createReceipt = { deviceId, data: receipt }; }
      response = await deviceApi('/threads', receipt, deviceId);
    }
    if (response.state === 'accepted' && response.result?.thread?.id) {
      localStorage.removeItem(creationReceiptKey(deviceId)); $('new-thread-dialog').createReceipt = null;
      $('new-thread-dialog').close();
      if (deviceId !== state.deviceId) { notice(`${deviceName(deviceId)}：对话已创建，请切换电脑查看`); return; }
      state.resultFilter = 'all'; state.view = 'recent'; $('search').value = '';
      document.querySelectorAll('[data-view]').forEach(b => { const active = b.dataset.view === 'recent'; b.classList.toggle('active', active); if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
      $('list-title').textContent = '会话';
      await loadList(); await openThread(response.result.thread.id);
      notice(response.result.warning || '新对话已创建，发送第一条消息即可开始');
    } else if (response.state === 'failed') {
      localStorage.removeItem(creationReceiptKey(deviceId)); $('new-thread-dialog').createReceipt = null;
      throw new Error(response.result?.error || '创建失败，可以重试');
    } else {
      button.textContent = '核对上次创建结果';
      throw new Error('创建结果尚未确认，请稍后点此核对，不会重复创建。也可返回列表查看。');
    }
  } catch (error) {
    if (error.status && error.status < 500) { localStorage.removeItem(creationReceiptKey(deviceId)); $('new-thread-dialog').createReceipt = null; }
    $('new-thread-error').textContent = error.message; $('new-thread-error').hidden = false;
  } finally { button.disabled = false; }
});
