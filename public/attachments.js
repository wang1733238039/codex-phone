/* Private, device/thread-scoped attachment drafts; no upload contents in localStorage. */
const PhoneAttachments = (() => {
  const drafts = new Map(), maximum = 200 * 1024 * 1024;
  let sessionEpoch = 0;
  const key = (thread = state.selected, device = state.deviceId) => scopeKey(thread, device);
  const path = item => `/api/devices/${item.deviceId}/threads/${item.threadId}/attachments${item.id ? `/${item.id}` : ''}`;
  const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const previewable = file => /^(image\/(png|jpeg|webp|gif|avif|bmp))$/i.test(file.type) ||
    (!file.type && /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name));
  function previewSource(item) {
    return item.previewUrl || (item.kind === 'image' && item.id && ['ready', 'syncing'].includes(item.stage) ? path(item) + '/content' : '');
  }
  function releasePreview(item) {
    if (!item.previewUrl) return;
    if ($('attachment-preview-image').getAttribute('src') === item.previewUrl) $('attachment-preview-dialog').close();
    URL.revokeObjectURL(item.previewUrl); item.previewUrl = '';
  }
  function list(thread = state.selected, device = state.deviceId) {
    const scope = key(thread, device);
    if (!drafts.has(scope)) {
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem(`codex-phone-attachments:${scope}`) || '[]'); } catch {}
      drafts.set(scope, saved.slice(0, 10).filter(a => a.id && a.threadId === thread && a.deviceId === device)
        .map(a => ({ ...a, busy: false, error: a.stage === 'ready' ? '' : '上传尚未完成，点击重试；若文件未上传完整，请重新选择原文件' })));
    }
    return drafts.get(scope);
  }
  function persist(items) {
    if (!items.length) return;
    const scope = key(items[0].threadId, items[0].deviceId);
    try { localStorage.setItem(`codex-phone-attachments:${scope}`, JSON.stringify(list(items[0].threadId, items[0].deviceId)
      .filter(a => a.id).map(({ file, controller, busy, previewUrl, ...a }) => a))); } catch {}
  }
  function changed(item) {
    persist([item]);
    if (item.deviceId === state.deviceId && item.threadId === state.selected) updateComposer();
  }
  async function request(item, suffix = '', method = 'POST', body = {}) {
    const response = await fetch(path(item) + suffix, { method, credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.any([item.controller.signal, AbortSignal.timeout(65000)]),
      headers: { 'X-CSRF-Token': state.csrf, ...(body instanceof Blob ? {} : { 'Content-Type': 'application/json' }) },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: body instanceof Blob ? body : JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || '附件请求失败'); error.status = response.status; throw error; }
    return result;
  }
  async function upload(item) {
    if (item.busy) return;
    item.busy = true; item.error = ''; item.controller = new AbortController(); const epoch = sessionEpoch;
    changed(item);
    try {
      let remote = item.id ? await request(item, '', 'GET') : await request(item, '', 'POST', { name: item.name, size: item.size });
      if (epoch !== sessionEpoch || item.removed) return;
      item.id = remote.id; item.kind = remote.kind; item.stage = 'uploading'; item.offset = remote.offset;
      if (remote.state === 'expired') throw new Error('附件缓存已过期，请移除后重新选择');
      if (remote.state === 'uploading') {
        if (!item.file && remote.offset < item.size) throw new Error('请再次选择同名原文件以继续上传');
        while (item.offset < item.size) {
          const slice = item.file.slice(item.offset, item.offset + remote.chunkBytes);
          try { remote = await request(item, `?offset=${item.offset}`, 'PUT', slice); }
          catch (error) {
            if (error.status && error.status < 500 || item.controller.signal.aborted) throw error;
            remote = await request(item, '', 'GET');
            if (remote.offset === item.offset) throw error;
          }
          item.offset = remote.offset; changed(item);
        }
        remote = await request(item, '/complete');
      }
      item.kind = remote.kind; item.stage = 'syncing'; item.remoteOffset = 0; changed(item);
      // Always verify this connection's actual disk state, including after a connector restart.
      do {
        remote = await request(item, '/sync'); item.remoteOffset = remote.remoteOffset; changed(item);
      } while (!remote.remoteReady && !item.removed && epoch === sessionEpoch);
      if (epoch !== sessionEpoch || item.removed) return;
      item.stage = 'ready'; item.offset = item.size; item.remoteOffset = item.size; item.file = null;
    } catch (error) {
      if (epoch !== sessionEpoch || item.removed) return;
      item.error = error.name === 'TimeoutError' ? '连接超时，点击重试继续上传' : error.message || '上传中断，点击重试';
    } finally { item.busy = false; if (epoch === sessionEpoch && !item.removed) changed(item); }
  }
  function add(files) {
    if (!state.selected) return;
    const items = list();
    for (const file of files) {
      const existing = items.find(a => !a.busy && a.error && a.name === file.name && a.size === file.size);
      if (existing) {
        existing.file = file;
        if (previewable(file)) { releasePreview(existing); existing.previewUrl = URL.createObjectURL(file); }
        upload(existing); continue;
      }
      if (file.size < 1 || file.size > maximum) { notice(`${file.name}：单个文件最大 200 MB，且不能为空`); continue; }
      if (file.type.startsWith('image/') && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) && file.size > 20 * 1024 * 1024) { notice('图片最大 20 MB，请先压缩'); continue; }
      if (items.length >= 10 || items.reduce((n, a) => n + a.size, 0) + file.size > maximum) { notice('每条最多 10 个附件，总计最大 200 MB'); break; }
      const item = { clientId: uuid(), threadId: state.selected, deviceId: state.deviceId, name: file.name, size: file.size,
        kind: previewable(file) ? 'image' : 'file', stage: 'uploading', offset: 0, remoteOffset: 0, file,
        ...(previewable(file) ? { previewUrl: URL.createObjectURL(file) } : {}) };
      items.push(item); upload(item);
    }
    updateComposer();
  }
  function forget(item) {
    item.removed = true; item.controller?.abort();
    releasePreview(item);
    const scope = key(item.threadId, item.deviceId), remaining = list(item.threadId, item.deviceId).filter(a => a !== item);
    drafts.set(scope, remaining);
    try { localStorage.removeItem(`codex-phone-attachments:${scope}`); } catch {}
    if (remaining.length) persist(remaining);
    updateComposer();
  }
  async function remove(item) {
    const pending = readPendingEntries(item.threadId, item.deviceId).some(p => p.attachmentIds?.includes(item.id));
    forget(item);
    // Detaching from a new draft must never remove an uncertain submission's source files.
    if (!item.id || pending) return;
    item.controller = new AbortController();
    try { await request(item, '', 'DELETE'); } catch (error) { if (error.status !== 409) notice(`材料已从草稿移除：${error.message}`); }
  }
  function accepted(thread, device, ids = []) {
    const scope = key(thread, device), items = list(thread, device);
    for (const item of items) if (ids.includes(item.id)) releasePreview(item);
    const remaining = items.filter(item => !ids.includes(item.id));
    drafts.set(scope, remaining); try { localStorage.removeItem(`codex-phone-attachments:${scope}`); } catch {}
    if (remaining.length) persist(remaining);
  }
  function identity(text, ids = []) { return JSON.stringify([text.trim(), [...ids].sort()]); }
  function current() { return state.selected ? list() : []; }
  function ids() { return current().filter(a => a.stage === 'ready' && !a.error).map(a => a.id); }
  function blocked() { return current().some(a => a.busy || a.error || a.stage !== 'ready'); }
  function render() {
    const allowed = Boolean(state.selected && state.detail && state.status.online && state.status.controls && state.detail.thread.local && !state.detail.thread.archived);
    const supported = Boolean(state.status.capabilities?.attachments);
    $('attach-button').disabled = !allowed || !supported;
    $('attachment-note').textContent = !state.selected ? '' : !state.status.online ? '电脑上线后可添加材料' :
      !supported ? '此电脑需更新连接程序至 0.4.0 才能上传附件' : '图片、文件、视频 · 最多 10 个 / 合计 200 MB';
    const items = current(), box = $('attachment-drafts'); box.hidden = !items.length;
    const focused = box.contains(document.activeElement) ? document.activeElement.dataset.attachmentFocus : null;
    box.replaceChildren();
    const images = items.filter(item => item.kind === 'image'), files = items.filter(item => item.kind !== 'image');
    if (images.length) {
      const strip = el('div', 'attachment-image-strip');
      strip.setAttribute('role', 'list'); strip.setAttribute('aria-label', `待发送图片，共 ${images.length} 张`);
      for (const item of images) {
        const tile = el('div', `attachment-image-tile${item.error ? ' has-error' : ''}${item.stage === 'ready' ? ' is-ready' : ''}`);
        tile.setAttribute('role', 'listitem');
        const source = previewSource(item);
        const image = source ? previewButton(item.name, source, 'attachment-draft-preview', `${item.clientId}:preview`, item) :
          el('button', 'attachment-image-unavailable');
        if (!source) {
          image.type = 'button'; image.setAttribute('aria-label', `图片 ${item.name} 暂无预览`);
          image.disabled = !item.error;
          image.append(icon('image'));
          if (item.error) image.onclick = () => $('attachment-input').click();
        }
        tile.append(image);
        const progress = el('progress', 'attachment-image-progress');
        progress.max = item.size * 2;
        progress.value = item.stage === 'ready' ? item.size * 2 :
          item.stage === 'syncing' ? item.size + (item.remoteOffset || 0) : item.offset;
        const caption = item.error || (item.stage === 'ready' ? '已传到电脑' : item.stage === 'syncing' ?
          `传到电脑 ${Math.floor(item.remoteOffset / item.size * 100)}%` : `上传 ${Math.floor(item.offset / item.size * 100)}%`);
        progress.setAttribute('aria-label', `${item.name} 上传进度`); progress.setAttribute('aria-valuetext', caption);
        tile.append(progress);
        if (item.error) {
          const retry = el('button', 'attachment-image-retry', '重试'); retry.type = 'button';
          retry.setAttribute('aria-label', `重试上传 ${item.name}`); retry.dataset.attachmentFocus = `${item.clientId}:retry`;
          retry.onclick = () => { if (!item.file && item.offset < item.size) { notice('请选择同名原文件，继续上次上传'); $('attachment-input').click(); } else upload(item); };
          tile.append(retry);
        }
        strip.append(tile);
      }
      box.append(strip);
    }
    for (const item of files) {
      const row = el('div', `attachment-draft${item.error ? ' has-error' : ''}`), info = el('div', 'attachment-info');
      const caption = item.error || (item.stage === 'ready' ? '已传到电脑' : item.stage === 'syncing' ?
        `传到电脑 ${Math.floor(item.remoteOffset / item.size * 100)}%${item.remoteOffset === item.size ? ' · 正在校验材料' : ''}` : `上传 ${Math.floor(item.offset / item.size * 100)}%`);
      info.append(el('strong', '', item.name), el('span', '', `${size(item.size)} · ${caption}`));
      const progress = el('progress'); progress.max = item.size * 2;
      progress.value = item.stage === 'ready' ? item.size * 2 : item.stage === 'syncing' ? item.size + (item.remoteOffset || 0) : item.offset;
      progress.setAttribute('aria-label', `${item.name} 上传进度`); info.append(progress);
      row.append(icon(item.kind), info);
      if (item.error) {
        const retry = el('button', 'text-button', '重试'); retry.type = 'button'; retry.dataset.attachmentFocus = `${item.clientId}:retry`;
        retry.onclick = () => { if (!item.file && item.offset < item.size) { notice('请选择同名原文件，继续上次上传'); $('attachment-input').click(); } else upload(item); };
        row.append(retry);
      }
      const deleting = readPendingEntries(item.threadId, item.deviceId).some(p => p.attachmentIds?.includes(item.id)) && state.sending.has(key(item.threadId, item.deviceId));
      const button = el('button', 'icon-button'); button.type = 'button'; button.setAttribute('aria-label', `移除 ${item.name}`);
      button.dataset.attachmentFocus = `${item.clientId}:remove`; button.disabled = deleting;
      button.append(icon('remove')); button.onclick = () => remove(item); row.append(button); box.append(row);
    }
    if (focused) [...box.querySelectorAll('[data-attachment-focus]')].find(e => e.dataset.attachmentFocus === focused)?.focus({ preventScroll: true });
  }
  function icon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), shape = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    shape.setAttribute('d', kind === 'remove' ? 'm6 6 12 12M6 18 18 6' : kind === 'image' ?
      'M3 3h18v18H3zM3 16l6-6 5 5 3-3 4 4M15 7h1' : kind === 'video' ?
        'M3 5h18v14H3zM10 9l5 3-5 3z' : 'M5 3h9l5 5v13H5zM14 3v6h5M8 13h8m-8 4h6');
    svg.append(shape); return svg;
  }
  function previewButton(name, source, className, focusId, draftItem = null) {
    const button = el('button', `attachment-preview-button ${className}`); button.type = 'button';
    button.setAttribute('aria-label', `预览图片 ${name}`); button.setAttribute('aria-haspopup', 'dialog');
    if (focusId) button.dataset.attachmentFocus = focusId;
    const image = el('img', 'attachment-thumbnail'); image.src = source; image.alt = name;
    image.width = 96; image.height = 96; image.loading = 'lazy';
    image.onerror = () => {
      button.replaceChildren(icon('image'), el('span', 'attachment-preview-fallback', '点此重试预览'));
    };
    button.append(image); button.onclick = () => showPreview(name, source, draftItem);
    return button;
  }
  function showPreview(name, source, draftItem = null) {
    const dialog = $('attachment-preview-dialog'), image = $('attachment-preview-image');
    $('attachment-preview-name').textContent = name;
    const removeButton = $('attachment-preview-remove');
    removeButton.hidden = !draftItem;
    removeButton.disabled = draftItem && readPendingEntries(draftItem.threadId, draftItem.deviceId)
      .some(p => p.attachmentIds?.includes(draftItem.id)) && state.sending.has(key(draftItem.threadId, draftItem.deviceId));
    removeButton.onclick = () => { if (draftItem) { dialog.close(); remove(draftItem); } };
    $('attachment-preview-status').textContent = '正在加载图片…'; $('attachment-preview-status').hidden = false;
    $('attachment-preview-retry').hidden = true;
    $('attachment-preview-viewport').classList.remove('is-zoomed');
    $('attachment-preview-zoom').textContent = '放大查看'; $('attachment-preview-zoom').setAttribute('aria-pressed', 'false');
    $('attachment-preview-zoom').disabled = true;
    image.hidden = true; image.alt = name;
    image.onload = () => { image.hidden = false; $('attachment-preview-status').hidden = true; $('attachment-preview-zoom').disabled = false; };
    image.onerror = () => {
      image.hidden = true; $('attachment-preview-status').hidden = false;
      $('attachment-preview-status').textContent = '图片暂时无法加载，可以重试或下载原图';
      $('attachment-preview-retry').hidden = false; $('attachment-preview-zoom').disabled = true;
    };
    image.src = source;
    const download = $('attachment-preview-download'); download.href = source; download.download = name;
    if (!dialog.open) dialog.showModal();
    $('attachment-preview-viewport').scrollTo(0, 0);
  }
  function cards(items, thread = state.selected, device = state.deviceId) {
    const box = el('div', 'message-attachments');
    for (const item of items || []) {
      const url = `/api/devices/${device}/threads/${thread}/attachments/${item.id}/content`;
      const preview = item.kind === 'image' && item.available;
      const link = el(item.available && !preview ? 'a' : 'div', `attachment-card${preview ? ' attachment-image-card' : ''}`);
      if (item.available && !preview) { link.href = url + '?download=1'; link.setAttribute('download', item.name); }
      link.append(preview ? previewButton(item.name, url, 'attachment-history-preview') : icon(item.kind));
      const info = el('span', 'attachment-info'); info.append(el('strong', '', item.name), el('span', '', item.available ?
        `${size(item.size)} · ${preview ? '点图查看大图' : '下载材料'}` : '服务器缓存已过期，电脑原文件仍保留'));
      link.append(info); box.append(link);
    }
    return box;
  }
  function reset() {
    sessionEpoch++; $('attachment-preview-dialog').close(); $('attachment-preview-image').removeAttribute('src');
    for (const items of drafts.values()) for (const item of items) { item.controller?.abort(); releasePreview(item); }
    drafts.clear(); $('attachment-drafts').replaceChildren(); $('attachment-input').value = '';
  }
  document.addEventListener('DOMContentLoaded', () => {
    const dialog = $('attachment-preview-dialog');
    dialog.addEventListener('close', () => {
      const image = $('attachment-preview-image'); image.onload = image.onerror = null; image.removeAttribute('src');
      $('attachment-preview-download').removeAttribute('href');
      markResultRead();
    });
    $('attachment-preview-zoom').onclick = () => {
      const zoomed = $('attachment-preview-viewport').classList.toggle('is-zoomed');
      $('attachment-preview-zoom').textContent = zoomed ? '适应屏幕' : '放大查看';
      $('attachment-preview-zoom').setAttribute('aria-pressed', String(zoomed));
      $('attachment-preview-viewport').scrollTo(0, 0);
    };
    $('attachment-preview-retry').onclick = () => showPreview($('attachment-preview-name').textContent, $('attachment-preview-download').getAttribute('href'));
    $('attach-button').onclick = () => $('attachment-input').click();
    $('attachment-input').onchange = event => { add(event.target.files); event.target.value = ''; };
    $('message').addEventListener('paste', event => { const files = [...event.clipboardData?.files || []]; if (files.length && !$('attach-button').disabled) { event.preventDefault(); add(files); } });
    $('composer').addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
    $('composer').addEventListener('drop', event => { if (event.dataTransfer?.files.length) { event.preventDefault(); if (!$('attach-button').disabled) add(event.dataTransfer.files); } });
  });
  return { render, ids, blocked, current, accepted, identity, cards, reset };
})();
