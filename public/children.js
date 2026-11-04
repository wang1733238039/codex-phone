/* Families and reading positions are scoped to this authenticated device. */
function selectedThread() {
  return state.detail?.thread || state.family?.threads.find(t => t.id === state.selected) || state.threads.find(t => t.id === state.selected);
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
  $('create-child').disabled = Boolean(!state.family || !state.status.online || !state.status.controls || !state.status.capabilities?.childControls || childReadOnly() || selectedThread()?.archived || selectedThread()?.local !== true || state.creatingChild || state.childCreationUnknown || !PhoneAccounts.active());
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
    state.creatingChild = true; renderFamilyList();
    $('child-create-status').textContent = '正在创建子对话…';
    try {
      const data = await deviceApi('/threads', { parentThreadId, title: '手机子对话', requestId: uuid() }, deviceId);
      if (data.state === 'failed') throw Object.assign(new Error(data.result?.error || '子对话创建失败'), { status: 400 });
      if (data.state !== 'accepted' || !data.result?.thread?.id) {
        state.childCreationUnknown = true;
        throw new Error(data.result?.error || '创建结果待确认，请刷新对话列表核对，避免重复创建');
      }
      if (deviceId !== state.deviceId || parentThreadId !== state.selected) return;
      $('family-dialog').close();
      await openThread(data.result.thread.id);
      notice(data.result.warning || '子对话已创建，可以发送消息');
    } catch (error) {
      if (!error.status || error.status >= 500) state.childCreationUnknown = true;
      $('child-create-status').textContent = error.message;
    } finally { state.creatingChild = false; if ($('family-dialog').open) renderFamilyList(); }
  };
  $('family-button').onclick = () => {
    renderFamilyList(); $('family-dialog').showModal(); loadFamily();
  };
  $('return-main-thread').onclick = () => {
    const id = state.family?.rootId || selectedThread()?.rootThreadId;
    if (id) openThread(id).catch(e => notice(e.message));
  };
});
