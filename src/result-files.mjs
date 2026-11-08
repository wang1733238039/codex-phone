import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { resultReferences, localResultReference } from './result-references.mjs';
import { CHUNK_BYTES, MAX_FILE_BYTES, detectType } from './attachment-common.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const fail = text => { throw new Error(text); };
const same = (before, after) => { if (before !== after) fail('文件已变化，请重新打开预览'); };
const blocked = path => path.split(/[\\/]/).some(part =>
  /^(?:\.git|\.ssh|\.config|\.codex|\.data|node_modules)$/i.test(part) ||
  /^(?:\.env(?:\..*)?|auth\.json|config\.toml|agent(?:\.remote)?\.json|server\.json)$/i.test(part) ||
  /\.(?:key|pem|pfx|p12|sqlite(?:-wal|-shm)?|db)$/i.test(part));

// Read-only results, authorized again from an actual final answer on every
// request. The phone supplies an opaque id, never an arbitrary computer path.
export class ResultFiles {
  constructor(context, config = {}) { this.context = context; this.config = config; this.cache = new Map(); }
  descriptors(threadId, detail) {
    const byMessage = new Map();
    for (const { index, reference } of resultReferences(detail.messages)) {
      const message = detail.messages[index];
      const item = { id: hash(JSON.stringify([threadId, message.id || '', message.text, reference])),
        reference, name: basename(localResultReference(reference).replaceAll('\\', '/')) };
      const list = byMessage.get(index) || []; list.push(item); byMessage.set(index, list);
    }
    return { ...detail, messages: (detail.messages || []).map((message, index) => ({
      ...message, ...(byMessage.has(index) ? { resultFiles: byMessage.get(index) } : {}),
    })) };
  }
  async authorized(threadId, id) {
    if (!/^[a-f\d]{64}$/.test(id || '')) fail('返回文件编号无效');
    const { detail, cwd } = await this.context(threadId);
    const item = this.descriptors(threadId, detail).messages.flatMap(message => message.resultFiles || []).find(item => item.id === id);
    if (!item) fail('此文件不属于当前会话的最终回复，请刷新会话');
    const reference = localResultReference(item.reference);
    if (!cwd || !isAbsolute(cwd)) fail('此会话没有可核验的工作目录');
    // A Windows absolute path is not a POSIX relative path, or vice versa.
    if (process.platform !== 'win32' && /^[a-z]:/i.test(reference)) fail('文件路径属于另一种电脑系统');
    if (process.platform === 'win32' && /^\/(?![a-z]:)/i.test(reference)) fail('此沙箱路径在当前电脑上不可用');
    const candidate = resolve(cwd, reference);
    if (blocked(candidate)) fail('此路径属于私有配置或密钥，不能通过网页读取');
    const actual = await realpath(candidate);
    if (blocked(actual)) fail('文件真实路径属于私有配置或密钥');
    const roots = [cwd, ...(this.config.resultFileRoots || [])];
    let allowed = false;
    for (const root of roots) {
      try { if (inside(await realpath(root), actual)) { allowed = true; break; } } catch {}
    }
    if (!allowed) fail('文件在当前项目授权目录之外，请在电脑移入项目后重新返回链接');
    return { ...item, path: actual, candidate };
  }
  async checked(item, work) {
    const handle = await open(item.path, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) fail('此链接指向目录，不能预览');
      if (before.size > BigInt(MAX_FILE_BYTES)) fail('文件超过 200 MB，请在电脑上处理');
      if (await realpath(item.candidate) !== item.path) fail('文件链接目标已变化，请重新打开');
      const result = await work(handle, before);
      same(stamp(before), stamp(await handle.stat({ bigint: true })));
      if (await realpath(item.candidate) !== item.path) fail('文件链接目标已变化，请重新打开');
      return result;
    } finally { await handle.close(); }
  }
  async info(data) {
    try {
      const item = await this.authorized(data.threadId, data.id);
      return await this.checked(item, async (handle, stat) => {
        const signature = stamp(stat), cached = this.cache.get(data.id);
        if (cached?.signature === signature && cached.path === item.path) return cached.meta;
        const digest = createHash('sha256'), bytes = Buffer.alloc(CHUNK_BYTES), head = Buffer.alloc(32);
        let offset = 0;
        while (offset < Number(stat.size)) {
          const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, Number(stat.size) - offset), offset);
          if (!bytesRead) fail('文件读取中断，请重试');
          if (!offset) bytes.copy(head, 0, 0, Math.min(head.length, bytesRead));
          digest.update(bytes.subarray(0, bytesRead)); offset += bytesRead;
        }
        const meta = { id: data.id, name: item.name, size: Number(stat.size), hash: digest.digest('hex'),
          ...detectType(head, item.name), chunkBytes: CHUNK_BYTES };
        this.cache.set(data.id, { signature, path: item.path, meta });
        if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
        return meta;
      });
    } catch (error) { this.failure(error); }
  }
  async chunk(data) {
    try {
      if (!Number.isSafeInteger(data.offset) || data.offset < 0 || !/^[a-f\d]{64}$/.test(data.hash || '')) fail('文件分块参数无效');
      const meta = await this.info(data);
      if (meta.hash !== data.hash || data.offset >= meta.size) fail('文件已变化或断点无效，请重新打开');
      const item = await this.authorized(data.threadId, data.id), cached = this.cache.get(data.id);
      return await this.checked(item, async (handle, stat) => {
        same(cached?.signature, stamp(stat));
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, meta.size - data.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, data.offset);
        if (bytesRead !== buffer.length) fail('文件未读取完整，请重试');
        return { offset: data.offset, base64: buffer.toString('base64'), hash: meta.hash };
      });
    } catch (error) { this.failure(error); }
  }
  failure(error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('电脑上的文件已移动或删除');
    if (['EACCES', 'EPERM'].includes(error.code)) fail('电脑拒绝读取此文件，请检查权限');
    throw error;
  }
}
