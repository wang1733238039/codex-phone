/* Read-only result viewer. Targets are captured before asynchronous reads. */
const PhoneResults = (() => {
  let active = null, worker = null, workerTimer = null;
  const maximum = 8 * 1024 * 1024;
  const escape = value => String(value || '').replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const normalized = value => { try { return decodeURIComponent(value); } catch { return value; } };
  const fileUrl = (item, thread = state.selected, device = state.deviceId) =>
    `/api/devices/${device}/threads/${thread}/results/${item.id}`;
  const sizes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  function stopWorker() { clearTimeout(workerTimer); worker?.terminate(); worker = null; }
  function reset() {
    active?.controller.abort(); active = null; stopWorker();
    $('result-preview-dialog')?.close();
    $('attachment-preview-dialog')?.close();
    $('result-preview-body')?.replaceChildren();
  }
  function begin(name, download) {
    reset();
    const current = active = { controller: new AbortController(), device: state.deviceId, thread: state.selected };
    $('result-preview-name').textContent = name;
    $('result-preview-note').textContent = '只读预览';
    $('result-sheet-label').hidden = true;
    $('result-preview-retry').hidden = true;
    const link = $('result-preview-download'); link.hidden = !download;
    if (download) { link.href = download; link.download = name; } else link.removeAttribute('href');
    $('result-preview-body').replaceChildren(el('p', 'result-loading', '正在从电脑读取文件…'));
    $('result-preview-dialog').showModal();
    return current;
  }
  const current = operation => active === operation && state.deviceId === operation.device && state.selected === operation.thread;
  async function read(url, operation) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.any([operation.controller.signal, AbortSignal.timeout(60000)]) });
    if (!response.ok) { let message; try { message = (await response.json()).error; } catch {} throw new Error(message || '文件读取失败，请重试'); }
    return response;
  }
  async function verifiedBytes(url, meta, operation) {
    const response = await read(url, operation);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== meta.size) throw new Error('文件未传输完整，请重试');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (digest !== meta.hash) throw new Error('文件校验失败，请重新打开');
    return bytes;
  }
  function sheetPreview(buffer, operation) {
    return new Promise((resolve, reject) => {
      worker = new Worker('/sheet-worker.js');
      const instance = worker;
      const aborted = () => {
        if (worker === instance) stopWorker();
        reject(new DOMException('阅读已取消', 'AbortError'));
      };
      operation.controller.signal.addEventListener('abort', aborted, { once: true });
      const finish = work => value => {
        operation.controller.signal.removeEventListener('abort', aborted);
        if (worker === instance) stopWorker();
        work(value);
      };
      instance.onmessage = finish(event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data));
      instance.onerror = finish(() => reject(new Error('表格读取失败，可下载原文件查看')));
      workerTimer = setTimeout(finish(() => reject(new Error('表格解析超时，可下载原文件查看'))), 10000);
      instance.postMessage(buffer, [buffer]);
    });
  }
  function renderWorkbook(book) {
    const select = $('result-sheet-select'); select.replaceChildren();
    for (const [index, sheet] of book.sheets.entries()) {
      const option = el('option', '', sheet.name); option.value = index; select.append(option);
    }
    $('result-sheet-label').hidden = book.sheets.length < 2;
    const show = () => {
      const sheet = book.sheets[Number(select.value) || 0], table = el('table', 'result-table');
      const body = el('tbody');
      for (const row of sheet.rows) {
        const tr = el('tr'); for (const value of row) tr.append(el('td', '', value)); body.append(tr);
      }
      table.append(body); table.setAttribute('aria-label', sheet.name);
      $('result-preview-body').replaceChildren(table);
      $('result-preview-body').scrollTo(0, 0);
      $('result-preview-note').textContent = `${sheet.totalRows} 行 · ${sheet.totalColumns} 列 · 左右滑动查看${sheet.truncated ? ' · 仅预览前 200 行 / 30 列，完整内容请下载' : ''}${book.truncated ? ' · 最多预览 10 个工作表' : ''}`;
    };
    select.onchange = show; show();
  }
  async function open(item, thread = state.selected, device = state.deviceId) {
    const base = fileUrl(item, thread, device), operation = begin(item.name, base + '/content?download=1');
    const retry = () => open(item, thread, device);
    $('result-preview-retry').onclick = retry;
    try {
      const meta = await (await read(base, operation)).json();
      if (!current(operation)) return;
      const content = `${base}/content?hash=${meta.hash}`;
      $('result-preview-note').textContent = sizes(meta.size);
      $('result-preview-download').href = content + '&download=1';
      if (meta.kind === 'image' && meta.size <= 20 * 1024 * 1024) {
        reset(); PhoneAttachments.preview(meta.name, content); return;
      }
      const sheet = /\.(xlsx|xls|csv|tsv|ods)$/i.test(meta.name), text = /\.(md|markdown|txt|json|log|ya?ml|xml)$/i.test(meta.name);
      const previewLimit = sheet ? maximum : 2 * 1024 * 1024;
      if ((!sheet && !text) || meta.size > previewLimit) {
        $('result-preview-body').replaceChildren(el('p', 'result-empty',
          meta.size > previewLimit ? '此文件较大，下载后用手机应用打开。' : '此格式可下载后用手机应用打开。图片、Excel、CSV 和文本支持网页预览。'));
        return;
      }
      const bytes = await verifiedBytes(content, meta, operation);
      if (!current(operation)) return;
      if (sheet) {
        const book = await sheetPreview(bytes, operation);
        if (current(operation)) renderWorkbook(book);
      } else {
        let source;
        try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('文本不是 UTF-8 编码，可下载原文件查看'); }
        if (/\.(md|markdown)$/i.test(meta.name)) {
          const body = el('div', 'result-markdown message-body'); render(body, { text: source, resultFiles: [] }, false);
          $('result-preview-body').replaceChildren(body);
        } else $('result-preview-body').replaceChildren(el('pre', 'result-text', source));
        $('result-preview-note').textContent = `${sizes(meta.size)} · UTF-8 文本 · 只读`;
      }
    } catch (error) {
      if (!current(operation) || error.name === 'AbortError') return;
      $('result-preview-body').replaceChildren(el('p', 'result-error',
        error.name === 'TimeoutError' ? '电脑响应超时，请重试；文件未作修改。' : error.message));
      $('result-preview-retry').hidden = false;
    }
  }
  function expandTable(table) {
    begin('回复中的表格', null);
    $('result-preview-body').replaceChildren(table.cloneNode(true));
    $('result-preview-note').textContent = '左右滑动查看完整表格 · 只读';
  }
  function safeWeb(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        !/^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])$/i.test(url.hostname);
    } catch { return false; }
  }
  function render(body, message, expandable = true) {
    const renderer = new marked.Renderer();
    renderer.image = token => `<a href="${escape(token.href)}">图片：${escape(token.text || '查看图片')}</a>`;
    body.innerHTML = DOMPurify.sanitize(marked.parse(message.text || '', { breaks: true, renderer }), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['img', 'picture', 'video', 'audio', 'source', 'iframe', 'style', 'form', 'input', 'button', 'textarea'],
      FORBID_ATTR: ['style', 'src', 'srcset', 'id', 'name'],
    });
    const rendered = new Set(), thread = state.selected, device = state.deviceId;
    for (const anchor of body.querySelectorAll('a')) {
      const href = anchor.getAttribute('href') || '';
      const item = (message.resultFiles || []).find(item => normalized(item.reference) === normalized(href));
      if (item) {
        const button = el('button', 'result-file-button', anchor.textContent || item.name);
        button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog');
        button.dataset.resultId = item.id;
        button.onclick = () => open(item, thread, device);
        anchor.replaceWith(button); rendered.add(item.id);
      } else if (safeWeb(href)) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
      else { anchor.removeAttribute('href'); anchor.classList.add('result-unavailable'); anchor.title = '此本地文件尚未接入；请更新电脑连接程序，或在电脑打开'; }
    }
    const remaining = (message.resultFiles || []).filter(item => !rendered.has(item.id));
    if (remaining.length) {
      const files = el('div', 'result-files');
      for (const item of remaining) {
        const button = el('button', 'result-file-button', item.name); button.type = 'button'; button.dataset.resultId = item.id;
        button.setAttribute('aria-haspopup', 'dialog'); button.onclick = () => open(item, thread, device); files.append(button);
      }
      body.append(files);
    }
    for (const table of body.querySelectorAll('table')) {
      const wrap = el('div', 'result-table-wrap'), scroll = el('div', 'result-table-scroll');
      scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '表格，可左右滑动');
      table.replaceWith(wrap); scroll.append(table);
      if (expandable) {
        const button = el('button', 'result-table-expand', '放大表格'); button.type = 'button';
        button.setAttribute('aria-haspopup', 'dialog'); button.onclick = () => expandTable(table); wrap.append(button);
      }
      wrap.append(scroll);
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    $('result-preview-dialog').addEventListener('close', () => {
      if ($('result-preview-dialog').open) return;
      active?.controller.abort(); active = null; stopWorker(); markResultRead();
    });
  });
  return { render, reset, open };
})();
