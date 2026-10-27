import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../src/server.mjs';
import { AgentAttachments } from '../src/agent-attachments.mjs';
import { hashPassword } from '../src/config.mjs';
import { buildInputs, attachmentText } from '../src/attachment-common.mjs';
import { TRANSCRIPT_VERSION } from '../src/transcript.mjs';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const dir = mkdtempSync(join(tmpdir(), 'phone-browser-attachments-')), artifacts = resolve('artifacts/attachments');
mkdirSync(artifacts, { recursive: true });
const app = createApp({ database: join(dir, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword('test-pass'), agentToken: 'test', controlsEnabled: true });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${app.server.address().port}`, threadId = randomUUID(), otherThreadId = randomUUID(), sent = [];
const receiver = new AgentAttachments({ configPath: join(dir, 'agent', 'config.json'), agentToken: 'test' });
let input = '', lastIds = [], uncertain = false, holdSync = false, syncHeld = [], holdSend = false, sendHeld = [], queue = [];
const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: 'Bearer test' } }); await once(ws, 'open');
ws.on('message', async raw => {
  const m = JSON.parse(raw); if (m.type !== 'request') return;
  try {
    let data;
    if (m.action.startsWith('attachment-')) {
      if (m.action === 'attachment-start' && holdSync) await new Promise(r => syncHeld.push(r));
      data = await receiver[m.action.slice(11)](m.data);
    } else if (m.action === 'models') data = { models: [] };
    else if (m.action === 'detail') data = { id: m.data.threadId, transcriptVersion: TRANSCRIPT_VERSION, running: false,
      execution: { state: 'idle', owned: false }, queue,
      messages: [{ id: 'user', role: 'user', ...attachmentText(input || '测试会话') }, { id: 'final', role: 'assistant', phase: 'final_answer', text: '材料已收到' }] };
    else if (m.action === 'send') {
      sent.push(m.data);
      if (holdSend) await new Promise(r => sendHeld.push(r));
      if (uncertain) { ws.send(JSON.stringify({ type: 'response', id: m.id, error: '测试网络中断；请核对发送状态', uncertain: true })); return; }
      input = buildInputs(m.data.text, await receiver.selected(m.data.threadId, m.data.attachments))[0].text;
      lastIds = m.data.attachments.map(a => a.id); data = { turnId: randomUUID(), delivery: 'started' };
    } else data = { ok: true };
    ws.send(JSON.stringify({ type: 'response', id: m.id, data }));
  } catch (error) { ws.send(JSON.stringify({ type: 'response', id: m.id, error: error.message })); }
});
ws.send(JSON.stringify({ type: 'snapshot', threads: [threadId, otherThreadId].map((id, index) => ({ id, title: index ? '另一个会话' : '材料上传验证', local: true, archived: false })),
  info: { controls: true, capabilities: { models: true, attachments: true, queue: true } } }));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), errors = [];
page.on('pageerror', error => errors.push(error.message));
const file = (name, buffer = Buffer.from('中文材料验证')) => ({ name, mimeType: name.endsWith('.png') ? 'image/png' : 'application/octet-stream', buffer });
const ready = count => page.waitForFunction(n => PhoneAttachments.current().length === n && !PhoneAttachments.blocked(), count, { timeout: 60000 });
async function thread(id) { await page.evaluate(id => openThread(id), id); await page.waitForFunction(id => state.selected === id && !!state.detail, id); }
try {
  await page.goto(origin); await page.locator('#password').fill('test-pass'); await page.locator('#login-button').click();
  await page.locator('.thread-row').first().waitFor(); await thread(threadId);
  assert.equal(await page.locator('#attach-button').isEnabled(), true);
  const png = await page.screenshot();
  holdSync = true;
  await page.locator('#attachment-input').setInputFiles([file('手机照片.png', png), file('中文说明.txt')]);
  const draftPreview = page.locator('.attachment-draft-preview');
  await draftPreview.waitFor();
  await page.waitForFunction(() => document.querySelector('.attachment-draft-preview img')?.naturalWidth > 0);
  await draftPreview.click(); await page.locator('#attachment-preview-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('attachment-preview-image').naturalWidth > 0);
  assert.equal(await page.locator('#attachment-preview-image').getAttribute('alt'), '手机照片.png');
  assert.equal(await page.locator('#attachment-preview-image').evaluate(image => image.naturalWidth), 390);
  assert.ok((await page.locator('#attachment-preview-image').getAttribute('src')).startsWith('blob:'), 'local preview works before upload completes');
  await page.locator('#attachment-preview-zoom').click();
  assert.equal(await page.locator('#attachment-preview-zoom').getAttribute('aria-pressed'), 'true');
  await page.locator('[aria-label="关闭图片预览"]').click();
  holdSync = false; syncHeld.splice(0).forEach(r => r()); await ready(2);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('codex-phone-attachments:') &&
    localStorage.getItem(key).includes('blob:'))), false, 'blob URLs and file contents never enter persistent drafts');
  assert.equal(await page.locator('#send-button').isEnabled(), true, 'attachment-only submission is enabled');
  await page.screenshot({ path: join(artifacts, 'phone-attachments-ready.png'), fullPage: true });
  await thread(otherThreadId); assert.equal(await page.locator('#attachment-drafts').isHidden(), true);
  await thread(threadId); assert.equal(await page.locator('.attachment-draft').count(), 2);
  await page.reload(); await ready(2); assert.equal(await page.locator('#send-button').isEnabled(), true);
  await page.waitForFunction(() => document.querySelector('.attachment-draft-preview img')?.naturalWidth > 0);
  await page.locator('.attachment-draft-preview').click();
  await page.waitForFunction(() => !document.getElementById('attachment-preview-image').hidden);
  assert.ok((await page.locator('#attachment-preview-image').getAttribute('src')).includes('/content'), 'restored draft uses private server image');
  await page.keyboard.press('Escape');
  await page.locator('#send-button').click(); await page.waitForFunction(() => !PhoneAttachments.current().length && !state.sending.size);
  assert.equal(sent.length, 1); assert.equal(sent[0].text, ''); assert.equal(sent[0].attachments.length, 2);
  await page.locator('.message-attachments .attachment-card').first().waitFor();
  assert.equal(await page.locator('.message.user .attachment-card').count(), 2);
  await page.locator('.attachment-history-preview').click();
  await page.waitForFunction(() => !document.getElementById('attachment-preview-image').hidden);
  await page.screenshot({ path: join(artifacts, 'phone-image-preview.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.attachment-history-preview').evaluate(node => document.activeElement === node), true, 'closing preview restores keyboard focus');
  assert.equal(await page.locator('.message-body').filter({ hasText: 'codex-phone-attachments' }).count(), 0);
  holdSync = true;
  await page.locator('#attachment-input').setInputFiles(file('弱网恢复.txt', Buffer.alloc(600000, 65)));
  await page.waitForFunction(() => PhoneAttachments.current()[0]?.stage === 'syncing');
  await page.locator('#message').fill('上传时仍然可以编辑');
  assert.equal(await page.locator('#message').isEnabled(), true);
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  holdSync = false; syncHeld.splice(0).forEach(r => r()); await ready(1);
  uncertain = true; await page.locator('#send-button').click();
  await page.waitForFunction(() => !state.sending.size && !!state.pending);
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  await page.locator('#message').fill('新消息仍能发送');
  assert.equal(await page.locator('#send-button').isEnabled(), true);
  uncertain = false; holdSend = true; await page.locator('#send-button').click();
  await page.waitForFunction(() => state.sending.size === 1);
  await page.locator('#attachment-input').setInputFiles(file('稍后再发.txt')); await ready(2);
  holdSend = false; sendHeld.splice(0).forEach(r => r());
  await page.waitForFunction(() => !state.sending.size && PhoneAttachments.current().length === 1);
  assert.equal(await page.locator('.attachment-draft .attachment-info strong').first().innerText(), '稍后再发.txt');
  await page.locator('.attachment-draft [aria-label^="移除"]').click();
  assert.equal(await page.locator('#attachment-drafts').isHidden(), true);
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal page overflow at ${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, 'phone-attachments-history.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const report = { passed: true, realReceiver: true, attachmentOnly: true, unicode: true, image: true, file: true, resumeAfterReload: true,
    localPreviewBeforeUpload: true, restoredDraftPreview: true, historyLightbox: true, zoom: true, previewFocusRestored: true, noPersistedBlobUrls: true,
    threadIsolation: true, typingDuringUpload: true, uncertaintyProtection: true, preserveNewAttachmentsDuringSend: true,
    viewportWidths: [375, 390, 1440], consoleErrors: errors };
  writeFileSync(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report));
} finally { syncHeld.forEach(r => r()); sendHeld.forEach(r => r()); await browser.close(); ws.terminate(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
