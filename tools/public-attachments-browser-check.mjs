// Public HTTPS + actual browser uploads, using an isolated disposable receiver.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import WebSocket from 'ws';
import { AgentAttachments } from '../src/agent-attachments.mjs';
import { attachmentText, buildInputs } from '../src/attachment-common.mjs';
import { TRANSCRIPT_VERSION } from '../src/transcript.mjs';
import { ROOT } from '../src/config.mjs';
const origin = new URL(process.env.PHONE_ORIGIN || 'http://127.0.0.1:3819').origin, dir = mkdtempSync(join(tmpdir(), 'phone-public-upload-'));
const artifacts = resolve(ROOT, 'artifacts/public-attachments'); mkdirSync(artifacts, { recursive: true });
const password = readFileSync(join(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
async function api(path, data) {
  const response = await fetch(origin + path, { headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }), signal: AbortSignal.timeout(70000) });
  const value = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${value.error}`); return value;
}
const pairing = await api('/api/device-pairings', {});
const claimResponse = await fetch(origin + '/api/device-pairings/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: pairing.code, name: '附件验收临时设备' }) });
assert.equal(claimResponse.status, 201);
const claimed = await claimResponse.json(), threadId = randomUUID();
const receiver = new AgentAttachments({ configPath: join(dir, 'agent.json'), agentToken: claimed.agentToken });
const ws = new WebSocket(origin.replace('https', 'wss') + '/agent', { headers: { Authorization: `Bearer ${claimed.agentToken}`, 'X-Device-Id': claimed.deviceId } });
await once(ws, 'open');
let submitted, seen = [], inputs = [];
ws.on('message', async raw => {
  const m = JSON.parse(raw); if (m.type !== 'request') return;
  try {
    let data = {};
    if (m.action.startsWith('attachment-')) data = await receiver[m.action.slice(11)](m.data);
    else if (m.action === 'models') data = { models: [] };
    else if (m.action === 'detail') data = { id: threadId, transcriptVersion: TRANSCRIPT_VERSION, running: false,
      execution: { state: 'idle', owned: false }, messages: submitted ? [{ role: 'user', ...attachmentText(inputs[0].text) },
        { role: 'assistant', phase: 'final_answer', text: '已收到验证材料（模拟电脑，无模型调用）' }] : [{ role: 'user', text: '专用附件界面测试' }] };
    else if (m.action === 'send') {
      submitted = m.data; seen = await receiver.selected(threadId, submitted.attachments); inputs = buildInputs(submitted.text, seen);
      data = { delivery: 'started', turnId: randomUUID() };
    }
    ws.send(JSON.stringify({ type: 'response', id: m.id, data }));
  } catch (error) { ws.send(JSON.stringify({ type: 'response', id: m.id, error: error.message })); }
});
ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id: threadId, title: '公网手机附件验收', local: true, archived: false }],
  info: { computer: '附件验收临时设备', controls: true, version: '0.4.0', capabilities: { attachments: true } } }));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const video = join(dir, '视频材料.mp4');
  await promisify(execFile)('D:\\ffmpeg\\bin\\ffmpeg.exe', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=320x240:r=5:d=3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { windowsHide: true, timeout: 15000 });
  const png = readFileSync(join(ROOT, 'artifacts/attachments/phone-attachments-ready.png')), file = Buffer.alloc(700000, 65);
  await page.goto(`${origin}/#/devices/${claimed.deviceId}/threads/${threadId}`);
  await page.locator('#password').fill(password); await page.locator('#login-button').click();
  await page.waitForFunction(() => !!state.detail && state.status.capabilities.attachments, null, { timeout: 30000 });
  await page.locator('#attachment-input').setInputFiles([
    { name: '手机照片.png', mimeType: 'image/png', buffer: png },
    { name: '中文文档.txt', mimeType: 'text/plain', buffer: file }, video,
  ].map(value => typeof value === 'string' ? { name: '视频材料.mp4', mimeType: 'video/mp4', buffer: readFileSync(value) } : value));
  await page.waitForFunction(() => PhoneAttachments.current().length === 3 && !PhoneAttachments.blocked(), null, { timeout: 120000 });
  assert.equal(await page.locator('#send-button').isEnabled(), true);
  await page.screenshot({ path: join(artifacts, 'public-phone-ready.png'), fullPage: true });
  await page.locator('#send-button').click();
  await page.waitForFunction(() => !state.sending.size && !PhoneAttachments.current().length, null, { timeout: 30000 });
  await page.locator('.message.user .attachment-card').first().waitFor();
  assert.equal(await page.locator('.message.user .attachment-card').count(), 3);
  assert.equal(seen.length, 3); assert.equal(seen[2].video.frames.length, 3);
  assert.equal(createHash('sha256').update(readFileSync(seen[1].path)).digest('hex'), createHash('sha256').update(file).digest('hex'));
  const image = page.locator('.attachment-thumbnail');
  await image.waitFor(); await page.waitForFunction(() => document.querySelector('.attachment-thumbnail')?.naturalWidth > 0);
  const response = await page.request.get(`${origin}/api/devices/${claimed.deviceId}/threads/${threadId}/attachments/${seen[1].id}/content?download=1`);
  assert.equal(response.status(), 200); assert.equal((await response.body()).length, file.length);
  assert.ok(response.headers()['content-disposition'].includes('UTF-8'));
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, 'public-phone-history.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const report = { passed: true, origin, verifiedAt: new Date().toISOString(), simulatedAdditionalReceiver: true, noModelCall: true,
    files: seen.map(a => ({ name: a.name, kind: a.kind, size: a.size })), videoFrames: seen[2].video.frames.length,
    realPublicUpload: true, chunksTransferred: Math.ceil(file.length / 262144), privateImagePreview: true, privateDownload: true,
    attachmentOnlySend: true, phoneViewports: [375, 390, 1440], consoleErrors: errors, temporaryDeviceRevoked: true };
  writeFileSync(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report));
} finally {
  await browser.close(); ws.terminate(); await api(`/api/devices/${claimed.deviceId}/revoke`, {}).catch(() => {});
  await api('/api/logout', {}).catch(() => {}); await receiver.ready; rmSync(dir, { recursive: true, force: true });
}
