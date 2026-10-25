import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { open, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { CHUNK_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_ATTACHMENTS, validId, filename, fail, privateDirectory, detectType, fileHash, serialByKey } from './attachment-common.mjs';

export class ServerAttachments {
  constructor(store, database, options = {}) {
    this.store = store; this.db = store.db; this.root = resolve(dirname(database), 'attachments');
    this.quota = options.attachmentQuotaBytes || 1024 * 1024 * 1024;
    this.lock = serialByKey(); this.ready = privateDirectory(this.root);
    this.db.exec(`CREATE TABLE IF NOT EXISTS attachments (
      owner_id TEXT NOT NULL, device_id TEXT NOT NULL, thread_id TEXT NOT NULL, id TEXT PRIMARY KEY,
      name TEXT NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'file',
      mime TEXT NOT NULL DEFAULT 'application/octet-stream', hash TEXT, state TEXT NOT NULL DEFAULT 'uploading',
      remote_ready INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, sent_at INTEGER);
      CREATE INDEX IF NOT EXISTS attachments_scope ON attachments(owner_id, device_id, thread_id);
      CREATE TABLE IF NOT EXISTS attachment_bindings (
      attachment_id TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(attachment_id,request_id));`);
  }
  get(deviceId, threadId, id) {
    if (!validId(id)) fail(404, '找不到此附件');
    const row = this.db.prepare('SELECT * FROM attachments WHERE owner_id=? AND device_id=? AND thread_id=? AND id=?')
      .get(...this.store.scope(deviceId), threadId, id);
    if (!row) fail(404, '找不到此附件');
    return row;
  }
  path(row) { return resolve(this.root, row.id); }
  public(row) {
    return { id: row.id, name: row.name, size: row.size, offset: row.offset, kind: row.kind, mime: row.mime,
      state: row.state, remoteReady: Boolean(row.remote_ready), available: row.state === 'ready', chunkBytes: CHUNK_BYTES };
  }
  async create(deviceId, threadId, data) {
    await this.ready; await this.cleanup();
    const name = filename(data.name), size = data.size;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) fail(413, '单个附件应为 1 字节至 200 MB');
    const outstanding = this.db.prepare("SELECT COUNT(*) n FROM attachments WHERE owner_id=? AND state!='expired' AND sent_at IS NULL").get(this.store.ownerId).n;
    if (outstanding >= 100) fail(429, '未发送附件过多，请删除不需要的材料');
    const used = this.db.prepare("SELECT COALESCE(SUM(size),0) n FROM attachments WHERE state!='expired'").get().n;
    if (used + size > this.quota) fail(413, '服务器附件空间不足，请清理旧附件');
    const id = randomUUID();
    this.db.prepare('INSERT INTO attachments(owner_id,device_id,thread_id,id,name,size,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(...this.store.scope(deviceId), threadId, id, name, size, Date.now());
    try { const handle = await open(resolve(this.root, id), 'wx', 0o600); await handle.close(); }
    catch (error) { this.db.prepare('DELETE FROM attachments WHERE id=?').run(id); throw error; }
    return this.public(this.get(deviceId, threadId, id));
  }
  async chunk(deviceId, threadId, id, offset, bytes) {
    return this.lock(id, async () => {
      const row = this.get(deviceId, threadId, id);
      if (row.state !== 'uploading') fail(409, '此附件已完成或已过期');
      if (!Number.isSafeInteger(offset) || offset < 0 || bytes.length < 1 || bytes.length > CHUNK_BYTES || offset + bytes.length > row.size) fail(400, '附件分块无效');
      const handle = await open(this.path(row), 'r+');
      try {
        const actual = (await handle.stat()).size;
        // Recover a completed disk write whose HTTP acknowledgement / SQLite update was interrupted.
        if (actual > row.offset && actual <= row.size) row.offset = actual;
        if (offset < row.offset) {
          const old = Buffer.alloc(bytes.length); await handle.read(old, 0, old.length, offset);
          if (offset + bytes.length > row.offset || !old.equals(bytes)) fail(409, '附件断点不匹配，请重新选择文件');
        } else {
          if (offset !== row.offset) fail(409, '附件断点已变化，请重试');
          let written = 0;
          while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, offset + written)).bytesWritten;
          row.offset += bytes.length;
        }
        this.db.prepare('UPDATE attachments SET offset=? WHERE id=?').run(row.offset, id);
      } finally { await handle.close(); }
      return this.public(row);
    });
  }
  async complete(deviceId, threadId, id) {
    return this.lock(id, async () => {
      const row = this.get(deviceId, threadId, id);
      if (row.state === 'ready') return this.public(row);
      if (row.state !== 'uploading' || row.offset !== row.size || (await stat(this.path(row))).size !== row.size) fail(409, '附件尚未上传完整');
      const handle = await open(this.path(row), 'r'), head = Buffer.alloc(Math.min(32, row.size));
      try { await handle.read(head, 0, head.length, 0); } finally { await handle.close(); }
      const type = detectType(head, row.name);
      if (type.kind === 'image' && row.size > MAX_IMAGE_BYTES) fail(413, '图片最大 20 MB，请压缩后重新上传');
      row.hash = await fileHash(this.path(row)); Object.assign(row, type, { state: 'ready' });
      this.db.prepare("UPDATE attachments SET state='ready',hash=?,kind=?,mime=? WHERE id=?").run(row.hash, row.kind, row.mime, id);
      return this.public(row);
    });
  }
  async sync(deviceId, threadId, id, ask) {
    return this.lock(id, async () => {
      const row = this.get(deviceId, threadId, id);
      if (row.state !== 'ready') fail(409, '附件未上传完整或已过期');
      const meta = { id: row.id, name: row.name, size: row.size, hash: row.hash, kind: row.kind, threadId };
      const current = await ask(deviceId, 'attachment-start', meta);
      if (current.ready) {
        this.db.prepare('UPDATE attachments SET remote_ready=1 WHERE id=?').run(id);
        return { ...this.public({ ...row, remote_ready: 1 }), remoteOffset: row.size };
      }
      let offset = current.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.size) fail(502, '电脑返回的附件断点无效');
      const handle = await open(this.path(row), 'r');
      try {
        // Keep each request below browser/relay timeouts and every WebSocket frame below 512 KiB.
        for (let i = 0; i < 2 && offset < row.size; i++) {
          const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, row.size - offset));
          await handle.read(bytes, 0, bytes.length, offset);
          const result = await ask(deviceId, 'attachment-chunk', { threadId, id, offset, base64: bytes.toString('base64') });
          if (result.offset !== offset + bytes.length) fail(502, '电脑返回的附件断点无效');
          offset = result.offset;
        }
      } finally { await handle.close(); }
      if (offset === row.size) {
        await ask(deviceId, 'attachment-finish', { threadId, id }, 55000);
        this.db.prepare('UPDATE attachments SET remote_ready=1 WHERE id=?').run(id);
      }
      return { ...this.public({ ...row, remote_ready: Number(offset === row.size) }), remoteOffset: offset };
    });
  }
  selected(deviceId, threadId, ids) {
    if (ids == null) return [];
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) fail(400, '每条消息最多 10 个不同附件');
    const rows = ids.map(id => this.get(deviceId, threadId, id));
    if (rows.some(a => a.state !== 'ready' || !a.remote_ready)) fail(409, '请等待附件传到电脑后再发送');
    if (rows.reduce((sum, a) => sum + a.size, 0) > MAX_FILE_BYTES) fail(413, '每条消息附件总计最大 200 MB');
    return rows.map(a => ({ id: a.id, name: a.name, size: a.size, hash: a.hash, kind: a.kind }));
  }
  bind(ids, requestId) {
    for (const id of ids) {
      this.db.prepare('INSERT OR IGNORE INTO attachment_bindings VALUES(?,?)').run(id, requestId);
      this.db.prepare('UPDATE attachments SET sent_at=? WHERE id=?').run(Date.now(), id);
    }
  }
  async remove(deviceId, threadId, id) {
    return this.lock(id, async () => {
      const row = this.get(deviceId, threadId, id);
      const binding = this.db.prepare('SELECT b.request_id,c.state FROM attachment_bindings b LEFT JOIN commands c ON b.request_id=c.id AND c.device_id=? AND c.owner_id=? WHERE b.attachment_id=?').all(deviceId, this.store.ownerId, id);
      if (binding.some(b => b.state !== 'failed')) fail(409, '已发送或待确认的附件不能删除');
      await rm(this.path(row), { force: true });
      this.db.prepare('DELETE FROM attachment_bindings WHERE attachment_id=?').run(id);
      this.db.prepare('DELETE FROM attachments WHERE id=?').run(id); return { ok: true };
    });
  }
  hydrate(deviceId, threadId, messages = []) {
    return messages.map(message => ({ ...message, attachments: (message.attachmentIds || []).map(id => {
      try { return this.public(this.get(deviceId, threadId, id)); } catch { return { id, name: '电脑本地附件', available: false }; }
    }) }));
  }
  async content(deviceId, threadId, id, req, res, headers) {
    const row = this.get(deviceId, threadId, id);
    if (row.state !== 'ready') fail(410, '服务器附件缓存已过期，原文件仍保留在电脑');
    await stat(this.path(row));
    headers(res, row.mime);
    res.setHeader('Content-Disposition', `${row.kind === 'image' && !req.url.includes('download=1') ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`);
    res.setHeader('Content-Length', row.size); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    await pipeline(createReadStream(this.path(row)), res);
  }
  async cleanup() {
    const rows = this.db.prepare("SELECT * FROM attachments WHERE state!='expired' AND ((sent_at IS NULL AND created_at<?) OR (sent_at IS NOT NULL AND sent_at<?))")
      .all(Date.now() - 86400000, Date.now() - 7 * 86400000);
    for (const row of rows) await this.lock(row.id, async () => {
      const current = this.db.prepare('SELECT * FROM attachments WHERE id=?').get(row.id);
      if (!current || current.state === 'expired' ||
          (current.sent_at ? current.sent_at >= Date.now() - 7 * 86400000 : current.created_at >= Date.now() - 86400000)) return;
      await rm(this.path(row), { force: true });
      this.db.prepare("UPDATE attachments SET state='expired',remote_ready=0 WHERE id=?").run(row.id);
    });
  }
}
