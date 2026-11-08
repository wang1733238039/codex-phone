import { existsSync, realpathSync, statSync, createReadStream, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { relative, join, isAbsolute, sep } from 'node:path';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

export const MAX_ROLLOUT_BYTES = 256 * 1024 * 1024;

// Codex can keep the indexed .jsonl path after compressing it to .jsonl.zst.
// Resolve that exact sibling only; never search other homes or session IDs.
export function resolveRollout(home, indexedPath) {
  if (!indexedPath) throw new Error('会话文件不在此电脑，无法读取该历史');
  let path = indexedPath;
  if (!existsSync(path) && path.endsWith('.jsonl') && existsSync(path + '.zst')) path += '.zst';
  if (!existsSync(path)) throw new Error('会话文件不在此电脑，无法读取该历史');
  path = realpathSync.native(path);
  const allowed = ['sessions', 'archived_sessions'].some(folder => {
    const rel = relative(join(home, folder), path);
    return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
  if (!allowed) throw new Error('Session path is outside the Codex session directories');
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('会话历史路径不是文件');
  return { path, stat, compressed: path.endsWith('.jsonl.zst') };
}

function checkSize(size, maximum) {
  if (size > maximum) {
    const error = new Error('会话历史超过读取大小限制，暂不支持在手机读取');
    error.code = 'ROLLOUT_TOO_LARGE'; throw error;
  }
}
export function readRolloutBuffer(storage, maximum = MAX_ROLLOUT_BYTES) {
  checkSize(storage.stat.size, maximum);
  const bytes = readFileSync(storage.path);
  if (!storage.compressed) return bytes;
  try { return zstdDecompressSync(bytes, { maxOutputLength: maximum }); }
  catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') { checkSize(maximum + 1, maximum); }
    throw new Error('压缩会话历史读取失败，请在电脑核对记录完整性', { cause: error });
  }
}

// Bounded tail for the synchronous activity index. It retains no transcript.
export function rolloutTail(storage, start = 0, length = 1024 * 1024) {
  if (storage.compressed) {
    const bytes = readRolloutBuffer(storage);
    if (bytes.length < start) throw new Error('子对话历史已重写，请在电脑核对后重新连接');
    const offset = Math.max(start, bytes.length - length);
    return { text: bytes.subarray(offset).toString('utf8'), partialFirst: offset > start };
  }
  if (storage.stat.size < start) throw new Error('子对话历史已重写，请在电脑核对后重新连接');
  const offset = Math.max(start, storage.stat.size - length), fd = openSync(storage.path, 'r');
  try {
    const bytes = Buffer.alloc(Math.max(0, Math.min(storage.stat.size - offset, length)));
    return { text: bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, offset)).toString('utf8'), partialFirst: offset > start };
  } finally { closeSync(fd); }
}

async function* rolloutChunks(storage, start, maximum) {
  checkSize(storage.stat.size, maximum);
  const file = createReadStream(storage.path), decoder = storage.compressed ? createZstdDecompress() : null;
  const input = decoder ? file.pipe(decoder) : file;
  // pipe does not forward a source error to the destination by itself.
  const onFileError = error => decoder?.destroy(error);
  if (decoder) file.on('error', onFileError);
  let size = 0;
  try {
    for await (const chunk of input) {
      const before = size; size += chunk.length; checkSize(size, maximum);
      if (size > start) yield chunk.subarray(Math.max(0, start - before));
    }
    if (size < start) throw new Error('子对话历史已重写，请在电脑核对后重新连接');
  } finally { file.destroy(); decoder?.destroy(); }
}

export async function* rolloutLines(storage, { start = 0, maximum = MAX_ROLLOUT_BYTES } = {}) {
  const input = Readable.from(rolloutChunks(storage, start, maximum)).setEncoding('utf8');
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) yield line; }
  finally { lines.close(); input.destroy(); }
}
