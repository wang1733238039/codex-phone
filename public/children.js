/* Families and reading positions are scoped to this authenticated device. */
function selectedThread() {
  return state.detail?.thread || state.family?.threads.find(t => t.id === state.selected) || state.threads.find(t => t.id === state.selected);
}
const childReceipts = new Map();
function childReceiptKey(parentId, deviceId) { return `codex-phone-child-create:${scopeKey(parentId, deviceId)}`; }
function childReceipt(parentId, deviceId) {
  const key = childReceiptKey(parentId, deviceId);
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (value?.parentThreadId === parentId && typeof value.requestId === 'string') return value;
  } catch {}
  return childReceipts.get(key);
}
function saveChildReceipt(parentId, deviceId, receipt) {
  const key = childReceiptKey(parentId, deviceId);
  if (receipt) childReceipts.set(key, receipt); else childReceipts.delete(key);
  try { if (receipt) localStorage.setItem(key, JSON.stringify(receipt)); else localStorage.removeItem(key); } catch {}
}
function childReadOnly() { const thread = selectedThread(); return Boolean(thread?.readOnly || thread?.parentThreadId && !state.status.capabilities?.childControls); }
function resetFamily(retainId) {
  state.familySeq++;
  $('family-dialog').close(); state.familyError = '';
  if (!state.family?.threads.some(t => t.id === retainId)) {
    state.family = null; $('family-list').replaceChildren(); $('family-summary').textContent = '';
  }
  renderFamily();
}
function rememberReadingPosition() {
  if (!state.selected || !state.detail) return;
  const box = $('messages');
  state.readingViews.delete(selectedKey());
  state.readingViews.set(selectedKey(), { detail: state.detail, scrollTop: box.scrollTop });
  if (state.readingViews.size > 12) state.readingViews.delete(state.readingViews.keys().next().value);
}
async function loadFamily() {
  const id = state.selected, deviceId = state.deviceId;
  if (!id || !deviceId) return;
  const seq = ++state.familySeq;
  try {
    const data = await deviceApi(`/threads/${id}/family`, undefined, deviceId);
    if (seq !== state.familySeq || id !== state.selected || deviceId !== state.deviceId) return;
    state.family = data; state.familyError = ''; renderFamily(); renderList(); updateComposer();
  } catch (error) {
    if (seq !== state.familySeq || id !== state.selected || deviceId !== state.deviceId) return;
    state.familyError = error.message; renderFamily();
  }
}
function renderFamily() {
  const thread = selectedThread(), count = state.family ? state.family.threads.length - 1 : thread?.childCount || 0;
  const button = $('family-button');
  button.hidden = !state.selected;
  $('family-button-label').textContent = thread?.parentThreadId ? '切换对话' : count ? `子对话 ${count}` : '子对话';
  button.setAttribute('aria-label', `切换主对话与 ${count} 个子对话`);
  $('return-main-thread').disabled = !state.family?.rootId && !thread?.rootThreadId;
  if ($('family-dialog').open) renderFamilyList();
}
function renderFamilyList() {
  const box = $('family-list'), focusId = box.contains(document.activeElement) ? document.activeElement.dataset.familyThreadId : null;
  $('create-child').disabled = Boolean(!state.family || !state.status.online || !state.status.controls || !state.status.capabilities?.childControls || childReadOnly() || selectedThread()?.archived || selectedThread()?.ephemeral || selectedThread()?.local !== true || state.creatingChild || !PhoneAccounts.active());
  $('create-child').textContent = state.creatingChild ? '正在创建…' : childReceipt(state.selected, state.deviceId) ? '核对上次创建结果' : '新建子对话';
  const scroll = box.scrollTop; box.replaceChildren();
  $('family-summary').textContent = `${deviceName(state.deviceId)} · ${Math.max(0, (state.family?.threads.length || 1) - 1)} 个子对话`;
  if (state.familyError) {
    const error = el('div', 'family-error'), retry = el('button', 'secondary', '重新读取');
    error.append(el('p', '', `读取失败：${state.familyError}`));
    retry.type = 'button'; retry.onclick = () => { retry.disabled = true; loadFamily(); };
    error.append(retry); box.append(error);
  }
  if (!state.family) {
    if (!state.familyError) { box.setAttribute('aria-busy', 'true'); box.append(el('div', 'skeleton')); }
    return;
  }
  box.setAttribute('aria-busy', 'false');
  const root = state.family.threads.find(t => t.id === state.family.rootId), ordered = [];
  function visit(thread) {
    ordered.push(thread);
    state.family.threads.filter(t => t.parentThreadId === thread.id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id)).forEach(visit);
  }
  if (root) visit(root);
  for (const thread of ordered) {
    const button = el('button', 'family-choice'), text = el('span', 'family-choice-text'), meta = el('span', 'family-choice-meta');
    button.type = 'button'; button.dataset.familyThreadId = thread.id; button.dataset.depth = String(Math.min(3, thread.depth || 0));
    button.setAttribute('aria-current', String(thread.id === state.selected));
    const status = resultState(thread);
    text.append(el('strong', '', thread.title)); meta.append(el('span', '', thread.id === state.family.rootId ? '主对话' : '子对话'), el('span', `result-badge ${status.kind}`, status.text));
    if (thread.historyAvailable === false) meta.append(el('span', '', '历史不在此电脑'));
    text.append(meta); button.append(text);
    if (thread.id === state.selected) button.append(el('span', 'family-current', '当前'));
    button.onclick = () => { $('family-dialog').close(); openThread(thread.id).catch(e => notice(e.message)); };
    box.append(button);
  }
  box.scrollTop = scroll;
  if (focusId) [...box.querySelectorAll('[data-family-thread-id]')].find(b => b.dataset.familyThreadId === focusId)?.focus({ preventScroll: true });
}
document.addEventListener('DOMContentLoaded', () => {
  $('create-child').onclick = async () => {
    const parentThreadId = state.selected, deviceId = state.deviceId;
    if (state.creatingChild) return;
    let receipt = childReceipt(parentThreadId, deviceId), accepted = false;
    state.creatingChild = true; renderFamilyList();
    $('child-create-status').textContent = receipt ? '正在核对上次创建结果…' : '正在创建子对话…';
    try {
      let data;
      if (receipt) data = await deviceApi(`/commands/${receipt.requestId}`, undefined, deviceId);
      else {
        receipt = { parentThreadId, title: '手机子对话', requestId: uuid() };
        saveChildReceipt(parentThreadId, deviceId, receipt);
      }
      if (!data || data.state === 'not_found') data = await deviceApi('/threads', receipt, deviceId);
      for (let attempt = 0; data.state === 'pending' && attempt < 8; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        data = await deviceApi(`/commands/${receipt.requestId}`, undefined, deviceId);
      }
      if (data.state === 'failed') {
        saveChildReceipt(parentThreadId, deviceId, null);
        throw Object.assign(new Error(data.result?.error || '子对话创建失败，可以重试'), { status: 400 });
      }
      if (data.state !== 'accepted' || !data.result?.thread?.id) {
        throw new Error(data.result?.error || '创建结果待确认，请点“核对上次创建结果”，不会重复新建');
      }
      accepted = true;
      if (deviceId !== state.deviceId || parentThreadId !== state.selected) {
        notice(`${deviceName(deviceId)}：子对话已创建，返回原对话核对即可打开`); return;
      }
      await loadList();
      if (deviceId !== state.deviceId || parentThreadId !== state.selected) return;
      $('family-dialog').close();
      await openThread(data.result.thread.id);
      if (deviceId !== state.deviceId || state.detail?.id !== data.result.thread.id) {
        notice('子对话已创建，读取未完成；回到父对话核对即可重新打开'); return;
      }
      saveChildReceipt(parentThreadId, deviceId, null);
      $('child-create-status').textContent = '';
      notice(data.result.warning || '子对话已创建，可以发送消息');
    } catch (error) {
      if (!accepted && error.status && error.status < 500) saveChildReceipt(parentThreadId, deviceId, null);
      if (deviceId === state.deviceId && parentThreadId === state.selected) $('child-create-status').textContent = error.message;
      notice(error.message);
    } finally { state.creatingChild = false; if ($('family-dialog').open) renderFamilyList(); }
  };
  $('family-button').onclick = () => {
    if (!state.creatingChild) $('child-create-status').textContent = selectedThread()?.ephemeral ? '临时侧栏不能继续分支，请返回主对话新建子对话' : '';
    renderFamilyList(); $('family-dialog').showModal(); loadFamily();
  };
  $('return-main-thread').onclick = () => {
    const id = state.family?.rootId || selectedThread()?.rootThreadId;
    if (id) openThread(id).catch(e => notice(e.message));
  };
});
