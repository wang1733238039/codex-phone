import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { open, readFile, writeFile, stat, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './config.mjs';
import { CHUNK_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_ATTACHMENTS, validId, filename, safeFilename, privateDirectory, fileHash, detectType, serialByKey } from './attachment-common.mjs';

const execute = promisify(execFile);
const missing = error => error.code === 'ENOENT';
export class AgentAttachments {
  constructor(config) {
    const scope = createHash('sha256').update(config.agentToken).digest('hex').slice(0, 16);
    this.root = resolve(config.attachmentDirectory || join(dirname(config.configPath || join(ROOT, '.data', 'agent.json')), 'attachments'), scope);
    this.lock = serialByKey(); this.config = config; this.ready = null;
  }
  async directory(threadId, id) {
    if (!validId(threadId) || !validId(id)) throw new Error('附件或会话编号无效');
    this.ready ||= privateDirectory(this.root);
    await this.ready;
    const directory = join(this.root, threadId, id); await mkdir(directory, { recursive: true, mode: 0o700 }); return directory;
  }
  async manifest(threadId, id) {
    const directory = await this.directory(threadId, id);
    let data;
    try { data = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); }
    catch (error) { if (missing(error)) return null; throw new Error('附件清单损坏，请重新上传'); }
    if (data.id !== id || data.threadId !== threadId || !/^[a-f\d]{64}$/.test(data.hash)) throw new Error('附件清单无效');
    filename(data.name);
    if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_FILE_BYTES) throw new Error('附件清单大小无效');
    return data;
  }
  async save(directory, manifest) {
    await writeFile(join(directory, 'manifest.tmp'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(join(directory, 'manifest.tmp'), join(directory, 'manifest.json'));
  }
  async start(data) {
    return this.lock(data.id, async () => {
      const directory = await this.directory(data.threadId, data.id), name = filename(data.name);
      if (!Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_FILE_BYTES || !/^[a-f\d]{64}$/.test(data.hash)) throw new Error('附件大小或校验码无效');
      let meta = await this.manifest(data.threadId, data.id);
      if (meta && (meta.name !== name || meta.size !== data.size || meta.hash !== data.hash)) throw new Error('附件编号对应的内容不匹配');
      if (!meta) {
        meta = { id: data.id, threadId: data.threadId, name, size: data.size, hash: data.hash, ready: false };
        await this.save(directory, meta);
      }
      const path = join(directory, `original-${safeFilename(meta.name)}`);
      if (meta.ready) {
        try {
          if ((await stat(path)).size === meta.size && await fileHash(path) === meta.hash) return { ready: true, offset: meta.size };
        } catch (error) { if (!missing(error)) throw error; }
        throw new Error('电脑上的已完成附件已变更，请重新选择材料上传');
      }
      let size = 0;
      try { size = (await stat(join(directory, 'upload.part'))).size; }
      catch (error) { if (!missing(error)) throw error; const handle = await open(join(directory, 'upload.part'), 'wx', 0o600); await handle.close(); }
      if (size > data.size) throw new Error('电脑附件断点超出文件大小');
      return { ready: false, offset: size };
    });
  }
  async chunk(data) {
    return this.lock(data.id, async () => {
      const directory = await this.directory(data.threadId, data.id), meta = await this.manifest(data.threadId, data.id);
      if (!meta || meta.ready) throw new Error('附件接收尚未初始化或已完成');
      if (typeof data.base64 !== 'string' || data.base64.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(data.base64)) throw new Error('附件分块编码无效');
      const bytes = Buffer.from(data.base64, 'base64'), offset = data.offset;
      if (bytes.toString('base64') !== data.base64 || bytes.length < 1 || bytes.length > CHUNK_BYTES ||
          !Number.isSafeInteger(offset) || offset < 0 || offset + bytes.length > meta.size) throw new Error('附件分块大小无效');
      const handle = await open(join(directory, 'upload.part'), 'r+');
      try {
        const size = (await handle.stat()).size;
        if (offset < size) {
          const previous = Buffer.alloc(bytes.length); await handle.read(previous, 0, previous.length, offset);
          if (offset + bytes.length > size || !bytes.equals(previous)) throw new Error('电脑附件断点内容不匹配');
          return { offset: size };
        }
        if (offset !== size) throw new Error('电脑附件断点已变化，请重试');
        let written = 0;
        while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, offset + written)).bytesWritten;
        return { offset: offset + bytes.length };
      } finally { await handle.close(); }
    });
  }
  async finish(data) {
    return this.lock(data.id, async () => {
      const directory = await this.directory(data.threadId, data.id), meta = await this.manifest(data.threadId, data.id);
      if (!meta) throw new Error('找不到电脑附件');
      if (meta.ready) return { ready: true };
      const part = join(directory, 'upload.part'), path = join(directory, `original-${safeFilename(meta.name)}`);
      // A previous finish may have renamed the file before its reply or manifest write was interrupted.
      const source = existsSync(part) ? part : path;
      if ((await stat(source)).size !== meta.size || await fileHash(source) !== meta.hash) throw new Error('附件校验失败，请删除后重新上传');
      const handle = await open(source, 'r'), head = Buffer.alloc(Math.min(32, meta.size));
      try { await handle.read(head, 0, head.length, 0); } finally { await handle.close(); }
      const type = detectType(head, meta.name);
      if (type.kind === 'image' && meta.size > MAX_IMAGE_BYTES) throw new Error('图片最大 20 MB');
      if (source !== path) await rename(source, path);
      Object.assign(meta, type, { ready: true });
      if (meta.kind === 'video') meta.video = await this.video(path, directory);
      await this.save(directory, meta);
      return { ready: true, kind: meta.kind, videoPreview: meta.video?.frames?.length || 0 };
    });
  }
  async video(path, directory) {
    const video = { frames: [], note: '仅有原视频，未分析完整视频或音轨' };
    const ffmpeg = this.config.ffmpegBin || (process.platform === 'win32' && existsSync('D:\\ffmpeg\\bin\\ffmpeg.exe') ? 'D:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg');
    const ffprobe = this.config.ffprobeBin || (ffmpeg.includes('\\') || ffmpeg.includes('/') ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
    try {
      const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path], { windowsHide: true, timeout: 7000, maxBuffer: 64 * 1024 });
      const duration = Number(JSON.parse(stdout).format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) return video;
      video.duration = duration;
      for (const [index, proportion] of [0.1, 0.5, 0.9].entries()) {
        const seconds = Math.min(duration - 0.01, duration * proportion), frame = join(directory, `preview-${index + 1}.jpg`);
        await execute(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-ss', String(Math.max(0, seconds)), '-i', path, '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-q:v', '4', frame],
          { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
        if ((await stat(frame)).size > 0) video.frames.push({ seconds: Math.max(0, seconds), file: `preview-${index + 1}.jpg` });
      }
      video.note = '已提取带时间标签的预览帧；未分析完整视频或音轨';
    } catch { video.note = video.frames.length ? '已提取部分预览帧；未分析完整视频或音轨' : '未能抽帧；可用工具处理原视频，未分析完整视频或音轨'; }
    return video;
  }
  async selected(threadId, items = []) {
    if (!Array.isArray(items) || items.length > MAX_ATTACHMENTS || new Set(items.map(a => a.id)).size !== items.length) throw new Error('附件数量无效');
    const result = [];
    for (const item of items) {
      const meta = await this.manifest(threadId, item.id), directory = await this.directory(threadId, item.id);
      if (!meta?.ready || meta.hash !== item.hash || meta.size !== item.size) throw new Error('电脑附件尚未就绪');
      const path = join(directory, `original-${safeFilename(meta.name)}`);
      if ((await stat(path)).size !== meta.size || await fileHash(path) !== meta.hash) throw new Error('电脑附件已更改，请重新上传');
      result.push({ ...meta, path, ...(meta.video ? { video: { ...meta.video, frames: meta.video.frames
        .filter(f => /^preview-[1-3]\.jpg$/.test(f.file) && existsSync(join(directory, f.file)))
        .map(f => ({ seconds: f.seconds, path: join(directory, f.file) })) } } : {}) });
    }
    if (result.reduce((sum, item) => sum + item.size, 0) > MAX_FILE_BYTES) throw new Error('附件总计最大 200 MB');
    return result;
  }
}
