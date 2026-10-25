// Real app-server + real files, restricted to a disposable test thread.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { CodexClient } from '../src/codex.mjs';
import { ROOT, loadConfig } from '../src/config.mjs';
import { CHUNK_BYTES } from '../src/attachment-common.mjs';
if (!process.argv.includes('--run')) throw new Error('Pass --run to test real model input in a disposable thread.');
const origin = new URL(process.env.PHONE_ORIGIN || 'http://127.0.0.1:3819').origin;
const agentConfig = loadConfig('agent'), client = new CodexClient(agentConfig);
const artifact = resolve(ROOT, 'artifacts', origin.startsWith('https') ? 'public-attachments' : 'attachments');
mkdirSync(artifact, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'phone-attachments-real-'));
const password = readFileSync(join(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password }), signal: AbortSignal.timeout(15000) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0], { csrf, primaryDeviceId } = await login.json();
const remoteConfig = origin.startsWith('https') ? JSON.parse(readFileSync(join(ROOT, '.data/agent.remote.json'), 'utf8')) : null;
const deviceId = remoteConfig?.deviceId || primaryDeviceId;
async function api(route, method = 'GET', data) {
  const response = await fetch(origin + route, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf,
    ...(!Buffer.isBuffer(data) ? { 'Content-Type': 'application/json' } : {}) },
    ...(data === undefined ? {} : { body: Buffer.isBuffer(data) ? data : JSON.stringify(data) }), signal: AbortSignal.timeout(70000) });
  const value = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${value.error}`); return value;
}
const device = (route, method, data) => api(`/api/devices/${deviceId}${route}`, method, data);
const pause = ms => new Promise(r => setTimeout(r, ms));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
let threadId, completed = false, accepted = false, turnId;
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 240 }, deviceScaleFactor: 1 });
  await page.setContent('<html><body style="margin:0;background:white"><svg width="600" height="240" xmlns="http://www.w3.org/2000/svg"><circle cx="100" cy="120" r="65" fill="#d92d20"/><rect x="230" y="55" width="130" height="130" fill="#1570ef"/><path d="M490 50 560 185 420 185Z" fill="#12b76a"/></svg></body></html>');
  const imagePath = join(temporary, '手机图片.png'); await page.screenshot({ path: imagePath });
  const textPath = join(temporary, '中文材料.txt'), verificationCode = `ATT-${randomUUID().slice(0, 8).toUpperCase()}`;
  writeFileSync(textPath, `这是一份手机提交的材料。\n校验码：${verificationCode}\n`, 'utf8');
  const videoPath = join(temporary, '手机视频.mp4');
  await promisify(execFile)('D:\\ffmpeg\\bin\\ffmpeg.exe', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=320x240:r=5:d=3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], { windowsHide: true, timeout: 15000 });
  const status = await device('/status'); assert.equal(status.online, true); assert.equal(status.capabilities.attachments, true);
  assert.equal(status.activeTurns.length, 0, 'Do not restart or compete with an existing phone task');
  await client.start();
  const started = await client.call('thread/start', { cwd: temporary, ephemeral: false, approvalPolicy: 'never', sandbox: 'read-only',
    baseInstructions: 'This is a disposable attachment verification. Inspect only the attached image, file and video frames. Read the supplied text file with a tool, using UTF-8. Do not write files, change settings, browse or contact any other agent.',
    developerInstructions: 'Answer in Chinese. Report only what you actually observed. A few video frames do not establish audio or complete video analysis.' });
  threadId = started.thread.id;
  await client.call('thread/name/set', { threadId, name: 'Codex 随行 · 图片文件视频验收' });
  await client.call('thread/unsubscribe', { threadId });
  const exited = once(client.proc, 'exit'); client.close(); await exited;
  for (let i = 0; i < 30; i++) { if ((await device('/threads')).threads.some(t => t.id === threadId)) break; await pause(1000); }
  const ids = [], received = [];
  for (const path of [imagePath, textPath, videoPath]) {
    const name = path.split(/[\\/]/).at(-1), bytes = readFileSync(path), base = `/threads/${threadId}/attachments`;
    const meta = await device(base, 'POST', { name, size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES)
      await device(`${base}/${meta.id}?offset=${offset}`, 'PUT', bytes.subarray(offset, offset + CHUNK_BYTES));
    const complete = await device(`${base}/${meta.id}/complete`, 'POST', {});
    let synced; do { synced = await device(`${base}/${meta.id}/sync`, 'POST', {}); } while (!synced.remoteReady);
    ids.push(meta.id); received.push({ name, kind: complete.kind, size: statSync(path).size, remoteReady: synced.remoteReady });
  }
  console.log(JSON.stringify({ stage: 'received-on-computer', origin, received }));
  const result = await device(`/threads/${threadId}/send`, 'POST', { requestId: randomUUID(), attachmentIds: ids,
    text: '请实际查看我附加的图片，读取文本文件中的校验码，再查看视频预览帧。简短回复：图片的三种形状和对应颜色、文本校验码、视频预览主要颜色。不要把未提供的音轨或完整视频声称为已经分析。' });
  assert.equal(result.state, 'accepted'); accepted = true; turnId = result.result.turnId;
  let detail;
  for (let i = 0; i < 120; i++) {
    detail = await device(`/threads/${threadId}?refresh=1`);
    if (detail.messages.some(m => m.role === 'assistant' && m.text.includes(verificationCode)) && !detail.activeTurns.some(t => t.threadId === threadId)) { completed = true; break; }
    if (['failed', 'interrupted'].includes(detail.execution?.state)) break;
    await pause(2000);
  }
  const final = detail?.messages.filter(m => m.role === 'assistant').at(-1)?.text || '';
  const report = { origin, verifiedAt: new Date().toISOString(), testThreadId: threadId, received, completed,
    textFileRead: final.includes(verificationCode), imageObserved: /红/.test(final) && /蓝/.test(final) && /绿/.test(final) && /圆/.test(final) && /三角/.test(final),
    videoFramesObserved: /黄/.test(final), finalAnswer: final,
    historyCards: detail?.messages.filter(m => m.role === 'user').at(-1)?.attachments?.length,
    historyOnlyInputAndFinal: detail?.messages.every(m => m.role === 'user' || m.role === 'assistant' && m.phase === 'final_answer') };
  writeFileSync(join(artifact, 'flow-report.json'), JSON.stringify(report, null, 2), 'utf8');
  assert.equal(completed, true, `Attachment test did not complete: ${detail?.execution?.state}`);
  assert.equal(report.imageObserved, true); assert.equal(report.textFileRead, true); assert.equal(report.videoFramesObserved, true);
  assert.equal(report.historyCards, 3); assert.equal(report.historyOnlyInputAndFinal, true);
  assert.ok(!detail.messages.some(m => /codex-phone-attachments|original-.*\.txt/.test(m.text) && m.role === 'user'));
  console.log(JSON.stringify({ ...report, finalAnswer: undefined }));
} finally {
  await browser.close();
  if (threadId) {
    if (accepted && !completed && turnId) {
      try { const status = await device('/status'); if (status.activeTurns.some(t => t.threadId === threadId))
        await device(`/threads/${threadId}/stop`, 'POST', { turnId, connectionId: status.connectionId }); } catch {}
    }
    await pause(1700);
    try { await client.start(); await client.call('thread/archive', { threadId }); } catch (error) { console.error('Test thread archive requires follow-up:', error.message); }
  }
  client.close();
  await api('/api/logout', 'POST', {}).catch(() => {});
}
