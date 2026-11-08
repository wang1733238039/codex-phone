import { createHash } from 'node:crypto';
import { CHUNK_BYTES, MAX_FILE_BYTES, filename } from './attachment-common.mjs';

const fail = (status, text) => { const error = new Error(text); error.status = status; throw error; };
export function resultFileRoute(route) {
  return route.match(/^\/api\/threads\/([a-f\d-]{36})\/results\/([a-f\d]{64})(\/content)?$/i);
}
export function validateResultInfo(value, id) {
  if (!value || value.id !== id || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_FILE_BYTES ||
      !/^[a-f\d]{64}$/.test(value.hash || '') || value.chunkBytes !== CHUNK_BYTES) fail(502, '电脑返回的文件信息无效');
  return { id, name: filename(value.name), size: value.size, hash: value.hash, chunkBytes: CHUNK_BYTES,
    kind: value.kind === 'image' && /^image\/(?:png|jpeg|gif|webp)$/.test(value.mime) ? 'image' : 'file',
    mime: value.kind === 'image' && /^image\/(?:png|jpeg|gif|webp)$/.test(value.mime) ? value.mime : 'application/octet-stream' };
}
export async function serveResultFile({ req, res, headers, json, ask, deviceId, threadId, id, content, url }) {
  const meta = validateResultInfo(await ask(deviceId, 'result-file-info', { threadId, id }), id);
  if (!content) { json(res, 200, meta); return; }
  if (url.searchParams.has('hash') && url.searchParams.get('hash') !== meta.hash) fail(409, '文件已变化，请重新打开预览');
  const digest = createHash('sha256');
  let offset = 0;
  // Get the first block before committing response headers so missing/changed
  // files still return a useful error. Never assemble whole files in the relay.
  const next = async () => {
    const part = await ask(deviceId, 'result-file-chunk', { threadId, id, hash: meta.hash, offset });
    if (part?.offset !== offset || part.hash !== meta.hash || typeof part.base64 !== 'string' ||
        part.base64.length > Math.ceil(CHUNK_BYTES / 3) * 4) fail(502, '电脑返回的文件分块无效');
    const bytes = Buffer.from(part.base64, 'base64');
    if (bytes.toString('base64') !== part.base64 || bytes.length !== Math.min(CHUNK_BYTES, meta.size - offset)) fail(502, '文件未读取完整，请重试');
    digest.update(bytes); offset += bytes.length; return bytes;
  };
  let bytes = meta.size ? await next() : Buffer.alloc(0);
  headers(res, meta.mime);
  res.setHeader('Content-Length', meta.size);
  res.setHeader('X-Content-SHA256', meta.hash);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Disposition', `${meta.kind === 'image' && url.searchParams.get('download') !== '1' ? 'inline' : 'attachment'}; filename="result"; filename*=UTF-8''${encodeURIComponent(meta.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
  try {
    while (bytes.length && !res.destroyed) {
      // Retain the last chunk until whole-file verification passes.
      if (offset === meta.size) break;
      if (!res.write(bytes)) await new Promise(resolve => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done); res.once('close', done);
      });
      if (res.destroyed) return;
      bytes = await next();
    }
    if (res.destroyed) return;
    if (digest.digest('hex') !== meta.hash) fail(502, '文件校验失败，请重新下载');
    res.end(bytes);
  } catch (error) { res.destroy(error); }
}
