import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/config.mjs';
import { TRANSCRIPT_VERSION } from '../src/transcript.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'phone-browser-devices-')), artifacts = resolve('artifacts/multi-device');
mkdirSync(artifacts, { recursive: true });
const app = createApp({ database: join(dir, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword('test-pass'), agentToken: 'test-primary', controlsEnabled: true });
app.store.pairing('browser-code', Date.now() + 60000);
const bDevice = app.store.claim('browser-code', '家里电脑', 'test-second'), aId = app.store.primaryDeviceId, bId = bDevice.id, threadId = randomUUID();
await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${app.server.address().port}`;
const agents = [], held = [];
let holdSend = false, holdDetail = false;
for (const [token, deviceId, name] of [['test-primary', aId, '办公室电脑'], ['test-second', bId, '家里电脑']]) {
  const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: `Bearer ${token}` } }); agents.push(ws); await once(ws, 'open');
  ws.on('message', raw => {
    const msg = JSON.parse(raw); if (msg.type !== 'request') return;
    const respond = () => ws.send(JSON.stringify({ type: 'response', id: msg.id, data: msg.action === 'detail'
      ? { id: threadId, transcriptVersion: TRANSCRIPT_VERSION, running: false, messages: [{ role: 'user', text: `${name}输入` }, { role: 'assistant', phase: 'final_answer', text: `${name}回复` }] }
      : { turnId: `${deviceId}-turn` } }));
    if (deviceId === aId && ((holdSend && msg.action === 'send') || (holdDetail && msg.action === 'detail'))) held.push(respond); else respond();
  });
  ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id: threadId, title: `${name}会话`, local: true, archived: false, projectId: 'same-project', projectName: '相同项目' }],
    sidebar: { version: 1, projects: [{ id: 'same-project', name: '相同项目', expanded: true }] }, info: { computer: name }, activeTurns: [], approvals: [] }));
}
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
async function choose(deviceId, fromChat = false) {
  await page.locator(fromChat ? '#chat-device-button' : '#device-button').click();
  await page.locator(`[data-device-id="${deviceId}"]`).click();
  await page.waitForFunction(id => state.deviceId === id && state.threads.length === 1, deviceId);
}
try {
  await page.goto(origin); await page.locator('#password').fill('test-pass'); await page.locator('#login-button').click();
  await page.locator('.thread-row').waitFor({ state: 'visible' });
  await page.locator('#device-button').click();
  await page.locator('#devices-dialog').waitFor({ state: 'visible' });
  const rename = page.locator(`[data-device-focus="${aId}:rename"]`); await rename.focus();
  await page.evaluate(() => loadDevices());
  assert.equal(await rename.evaluate(node => document.activeElement === node), true, JSON.stringify(await page.evaluate(() => ({
    open: document.getElementById('devices-dialog').open, active: document.activeElement.outerHTML
  }))));
  await page.locator('[data-action="pair"]').click();
  await page.waitForFunction(() => document.getElementById('pair-code').textContent.length > 0);
  const code = await page.locator('#pair-code').textContent(); assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await page.screenshot({ path: join(artifacts, 'phone-device-menu.png') }); await page.keyboard.press('Escape');
  await page.locator('.thread-row').click(); await page.getByText('办公室电脑回复', { exact: true }).waitFor();
  await page.locator('#message').fill('办公室独立草稿');
  await choose(bId, true); await page.locator('.thread-row').click(); await page.getByText('家里电脑回复', { exact: true }).waitFor();
  assert.equal(await page.locator('#message').inputValue(), ''); await page.locator('#message').fill('家里独立草稿');
  await choose(aId, true); await page.getByText('办公室电脑回复', { exact: true }).waitFor();
  assert.equal(await page.locator('#message').inputValue(), '办公室独立草稿');
  holdSend = true; await page.locator('#send-button').click();
  await page.waitForFunction(() => state.pending !== null);
  await choose(bId, true); await page.getByText('家里电脑回复', { exact: true }).waitFor();
  assert.equal(await page.locator('#message').inputValue(), '家里独立草稿');
  for (const respond of held.splice(0)) respond(); holdSend = false;
  await page.waitForFunction(() => state.sending.size === 0);
  assert.equal(await page.locator('#message').inputValue(), '家里独立草稿'); assert.doesNotMatch(await page.locator('#messages').innerText(), /办公室/);
  await choose(aId, true); await page.getByText('办公室电脑回复', { exact: true }).waitFor();
  holdDetail = true;
  await page.evaluate(() => { void loadDetail(true); });
  await new Promise(r => setTimeout(r, 100));
  await choose(bId, true); await page.getByText('家里电脑回复', { exact: true }).waitFor();
  for (const respond of held.splice(0)) respond(); holdDetail = false;
  await page.waitForTimeout(150); assert.doesNotMatch(await page.locator('#messages').innerText(), /办公室/);
  assert.equal(await page.locator('#message').inputValue(), '家里独立草稿');
  for (const [width, height] of [[375, 812], [390, 844], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(artifacts, `devices-${width}.png`) });
  }
  await page.reload(); await page.getByText('家里电脑回复', { exact: true }).waitFor();
  assert.equal(await page.locator('#chat-device-name').textContent(), '家里电脑');
  agents[1].close(); await once(agents[1], 'close'); await page.waitForFunction(() => !state.status.online);
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  assert.equal(await page.locator('#cache-banner').isVisible(), true);
  await page.goto(origin + '/#' + threadId); await page.getByText('办公室电脑回复', { exact: true }).waitFor();
  assert.equal(await page.locator('#chat-device-name').textContent(), '办公室电脑');
  await page.evaluate(() => updateStatus({ online: true, controls: false, activeTurns: [{ threadId: state.selected, turnId: 'ui-check' }],
    approvals: [{ id: 'ui-check', threadId: state.selected, type: 'command', reason: 'Read-only UI check' }] }));
  assert.equal(await page.locator('#stop-button').isDisabled(), true);
  assert.equal(await page.locator('#approval-panel button:enabled').count(), 0);
  await page.evaluate(() => updateStatus({ controls: true, activeTurns: [], approvals: [] }));
  await page.route('**/commands/*', route => route.fulfill({ json: { state: 'not_found' } }));
  await page.evaluate(async () => { state.pending = { id: uuid(), submitted: 'Uncertain command' }; await checkPending(); });
  assert.equal(await page.evaluate(() => Boolean(state.pending)), true);
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  assert.deepEqual(errors, []);
  const report = { passed: true, verifiedAt: new Date().toISOString(), simulatedComputers: 2,
    checked: ['device-menu', 'device-menu-focus-retention', 'pair-code', 'same-thread-id', 'independent-drafts', 'send-completes-after-device-switch', 'late-detail-ignored', 'refresh-keeps-device', 'offline-cache', 'old-link-primary-only', 'read-only-stop-approval-disabled', 'unknown-command-keeps-send-protection', '375-390-1440-no-overflow'], pageErrors: errors };
  writeFileSync(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'); console.log(JSON.stringify(report));
} catch (e) { await page.screenshot({ path: join(artifacts, 'browser-failure.png') }); console.error(JSON.stringify({ errors, messages: await page.locator('#messages').innerText() })); throw e; }
finally { for (const respond of held.splice(0)) { try { respond(); } catch {} } await browser.close(); for (const ws of agents) ws.terminate(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
