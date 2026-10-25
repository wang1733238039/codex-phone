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
const dir = mkdtempSync(join(tmpdir(), 'phone-browser-controls-')), artifacts = resolve('artifacts/controls');
mkdirSync(artifacts, { recursive: true });
const app = createApp({ database: join(dir, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword('test-pass'), agentToken: 'test', controlsEnabled: true });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${app.server.address().port}`, threadId = randomUUID(), sent = [];
let running = true, queue = [], execution = { state: 'unconfirmed', owned: false }, uncertain = false, modelCalls = 0;
const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: 'Bearer test' } }); await once(ws, 'open');
ws.on('message', raw => {
  const m = JSON.parse(raw); if (m.type !== 'request') return;
  let data;
  if (m.action === 'models') { modelCalls++; data = { models: [{ id: 'local-model', name: '电脑模型', efforts: ['medium', 'high'] }] }; }
  else if (m.action === 'detail') data = { id: threadId, transcriptVersion: TRANSCRIPT_VERSION, running, execution, queue,
    lastActivityAt: Date.now(), messages: [{ role: 'user', text: '没有最终回复的原始输入' }] };
  else if (m.action === 'send') {
    sent.push(m.data);
    if (uncertain) { ws.send(JSON.stringify({ type: 'response', id: m.id, error: 'Connection result unknown', uncertain: true })); return; }
    queue.push({ id: randomUUID(), requestId: m.data.requestId, text: m.data.text }); data = { queued: true, queueId: queue.at(-1).id };
  } else if (m.action === 'queue-delete') { queue = queue.filter(q => q.id !== m.data.queueId); data = { ok: true }; }
  else data = { ok: true };
  ws.send(JSON.stringify({ type: 'response', id: m.id, data }));
});
ws.send(JSON.stringify({ type: 'snapshot', threads: [{ id: threadId, title: '任务状态验证', local: true, archived: false }], info: { controls: true, capabilities: { models: true, queue: true } } }));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin); await page.locator('#password').fill('test-pass'); await page.locator('#login-button').click();
  await page.locator('.thread-row').first().click(); await page.getByText('没有最终回复的原始输入', { exact: true }).waitFor();
  assert.match(await page.locator('#execution-status').innerText(), /未确认/);
  assert.equal(await page.locator('#message').isEnabled(), true);
  await page.locator('#message').fill('任务没有最终回复时继续追加');
  assert.equal(await page.locator('#send-button').isEnabled(), true);
  await page.locator('#send-button').click();
  await page.waitForFunction(() => !state.sending.size && document.getElementById('message').value === '');
  assert.match(await page.locator('#delivery-status').innerText(), /队列/);
  await page.locator('#message').fill('第二条追加');
  assert.equal(await page.locator('#send-button').isEnabled(), true);
  await page.locator('#send-button').click(); await page.waitForFunction(() => !state.sending.size);
  assert.equal(sent.length, 2); assert.notEqual(sent[0].requestId, sent[1].requestId);
  await page.locator('#queue-summary').click(); assert.equal(await page.locator('.queue-item').count(), 2);
  await page.locator('.queue-item button').first().click(); await page.waitForFunction(() => state.detail.queue.length === 1);
  await page.locator('#composer-settings-button').click();
  await page.locator('#composer-settings-dialog').waitFor({ state: 'visible' });
  await page.locator('#model-select').selectOption('local-model'); await page.locator('#effort-select').selectOption('high');
  await page.locator('#composer-settings-dialog button[type="submit"]').click();
  await page.locator('#message').fill('使用选中的电脑模型'); await page.locator('#send-button').click();
  await page.waitForFunction(() => !state.sending.size);
  assert.equal(sent.at(-1).model, 'local-model'); assert.equal(sent.at(-1).effort, 'high');
  ws.send(JSON.stringify({ type: 'state', activeTurns: [{ threadId, turnId: 'owned-turn' }], approvals: [] }));
  await page.waitForFunction(() => state.status.activeTurns?.some(t => t.threadId === state.selected));
  await page.locator('#composer-settings-button').click();
  await page.locator('#composer-settings-dialog').waitFor({ state: 'visible' });
  await page.locator('#send-mode').selectOption('steer');
  await page.locator('#composer-settings-dialog button[type="submit"]').click();
  assert.equal(await page.locator('#model-select').isDisabled(), true);
  assert.equal(await page.locator('#effort-select').isDisabled(), true);
  assert.match(await page.locator('#models-note').innerText(), /沿用正在执行的模型/);
  await page.locator('#message').fill('保留所选后续模型时也能补充本轮'); await page.locator('#send-button').click();
  await page.waitForFunction(() => !state.sending.size);
  assert.equal(sent.at(-1).mode, 'steer'); assert.equal(sent.at(-1).model, undefined); assert.equal(sent.at(-1).effort, undefined);
  uncertain = true;
  await page.locator('#message').fill('状态不确定的消息'); await page.locator('#send-button').click();
  await page.waitForFunction(() => !state.sending.size && state.pending);
  assert.equal(await page.locator('#message').isEnabled(), true);
  assert.equal(await page.locator('#send-button').isDisabled(), true, 'the uncertain original message cannot be duplicated');
  await page.locator('#message').fill('不重复原消息的新指令');
  assert.equal(await page.locator('#send-button').isEnabled(), true);
  uncertain = false; running = false; execution = { state: 'interrupted', owned: false, lastActivityAt: Date.now() };
  ws.send(JSON.stringify({ type: 'state', activeTurns: [], approvals: [] }));
  await page.waitForFunction(() => !state.status.activeTurns?.some(t => t.threadId === state.selected));
  await page.evaluate(() => loadDetail(true)); assert.match(await page.locator('#execution-status').innerText(), /中断/);
  assert.equal(await page.locator('#message').isEnabled(), true); assert.equal(await page.locator('#send-button').isEnabled(), true);
  const modelCallsBeforeReconnect = modelCalls;
  await page.evaluate(() => { updateStatus({ online: false }); state.models = []; updateStatus({ online: true }); });
  await page.waitForFunction(() => state.models.length > 0 && !document.getElementById('model-select').disabled);
  assert.ok(modelCalls > modelCallsBeforeReconnect, 'reconnecting automatically reloads the computer model list');
  for (const [width, height] of [[375, 812], [390, 844], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(artifacts, `controls-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  const report = { passed: true, verifiedAt: new Date().toISOString(), noModelCall: true,
    checked: ['draft-while-unconfirmed', 'send-without-final', 'second-queued-input', 'queue-visible-cancellable', 'local-model-and-effort-selection', 'steer-follows-active-model', 'model-list-recovers-on-reconnect',
      'uncertain-original-no-duplicate', 'unknown-result-allows-different-new-input', 'interrupted-without-final-continues', '375-390-1440-no-overflow'], pageErrors: errors };
  writeFileSync(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'); console.log(JSON.stringify(report));
} catch (error) { await page.screenshot({ path: join(artifacts, 'failure.png') }); throw error; }
finally { await browser.close(); ws.terminate(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
