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

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const dir = mkdtempSync(join(tmpdir(), 'phone-inbox-check-')), artifacts = resolve('artifacts/inbox');
mkdirSync(artifacts, { recursive: true });
const app = createApp({ database: join(dir, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword('test-pass'),
  agentToken: 'test', controlsEnabled: true, commandTimeoutMs: 400 });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${app.server.address().port}`, now = Date.now(), id = randomUUID(), interrupted = randomUUID(), old = randomUUID();
const threads = [
  { id, title: '刚完成的工作', activity: { state: 'completed', resultAt: now - 60000, resultKey: 'one' } },
  { id: interrupted, title: '中断的工作', activity: { state: 'interrupted' } },
  { id: old, title: '前天已完成', activity: { state: 'completed', resultAt: now - 2 * 86400000, resultKey: 'old' } }
].map(t => ({ ...t, local: true, archived: false, projectId: 'project', projectName: '测试项目' }));
const messages = new Map([[id, [{ role: 'assistant', phase: 'final_answer', text: '已经得到最终结果', time: new Date(now - 60000).toISOString() }]]]);
const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: 'Bearer test' } }); await once(ws, 'open');
let creates = 0, hold = false, held;
const snapshot = () => ws.send(JSON.stringify({ type: 'snapshot', threads, sidebar: { projects: [{ id: 'project', nativeId: 'native-project', name: '测试项目', expanded: true, rootPaths: [dir] }] },
  info: { controls: true, version: '0.5.0', capabilities: { models: true, createThread: true, activity: true } } }));
ws.on('message', raw => {
  const m = JSON.parse(raw); if (m.type !== 'request') return;
  const reply = data => ws.send(JSON.stringify({ type: 'response', id: m.id, data }));
  if (m.action === 'models') return reply({ models: [{ id: 'test-model', name: '本机模型', efforts: ['low'] }] });
  if (m.action === 'detail') return reply({ id: m.data.threadId, transcriptVersion: 2, running: false, execution: { state: 'completed' }, messages: messages.get(m.data.threadId) || [] });
  if (m.action === 'create-thread') {
    creates++; assert.equal(m.data.projectId, 'project'); assert.equal(m.data.rootPath, dir);
    const thread = { id: randomUUID(), title: m.data.title, projectId: 'project', projectName: '测试项目', local: true, archived: false };
    const finish = () => { threads.push(thread); snapshot(); reply({ thread }); };
    if (hold) held = finish; else finish();
  } else if (m.action === 'send') {
    messages.set(m.data.threadId, [{ role: 'user', text: m.data.text }, { role: 'assistant', phase: 'final_answer', text: '首条消息回复成功', time: new Date().toISOString() }]);
    return reply({ delivery: 'started' });
  }
});
snapshot();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin); await page.locator('#password').fill('test-pass'); await page.locator('#login-button').click();
  await page.locator('.thread-row').first().waitFor();
  assert.equal(await page.locator('#unread-count').innerText(), '1');
  assert.match(await page.locator(`[data-thread-id="${interrupted}"]`).innerText(), /已中断/);
  assert.match(await page.locator(`[data-thread-id="${id}"]`).innerText(), /有新结果.*已完成/s);
  await page.locator('#unread-results').click();
  assert.equal(await page.locator('.thread-row').count(), 1);
  await page.screenshot({ path: join(artifacts, 'unread-results.png') });
  await page.locator('.thread-row').click(); await page.getByText('已经得到最终结果', { exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('unread-count').textContent === '0');
  await page.locator('[data-action="back"]').click();
  assert.match(await page.locator('#thread-list').innerText(), /新结果都已查看/);
  await page.reload(); await page.locator('.thread-row').first().waitFor();
  assert.equal(await page.locator('#unread-count').innerText(), '0', 'read results persist on refresh');
  threads[1].activity = { state: 'completed', resultKey: 'new-result', resultAt: Date.now() };
  messages.set(interrupted, [{ role: 'assistant', phase: 'final_answer', text: '新结果二', time: new Date().toISOString() }]);
  snapshot(); await page.waitForFunction(() => document.getElementById('unread-count').textContent === '1');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('有新结果'));
  await page.locator('#new-thread-button').click();
  await page.locator('#new-thread-dialog').waitFor({ state: 'visible' });
  await page.locator('#new-thread-name').fill('手机创建的对话');
  await page.screenshot({ path: join(artifacts, 'new-thread-dialog.png') });
  await page.locator('#create-thread-submit').click();
  await page.waitForFunction(() => state.selected && state.detail?.thread.title === '手机创建的对话');
  await page.locator('#message').fill('第一条指令'); await page.locator('#send-button').click();
  await page.getByText('首条消息回复成功', { exact: true }).waitFor();
  await page.locator('[data-action="back"]').click();
  hold = true;
  await page.locator('#new-thread-button').click(); await page.locator('#new-thread-name').fill('超时恢复验证');
  await page.locator('#create-thread-submit').click(); await page.locator('#new-thread-error').waitFor({ state: 'visible' });
  assert.equal(creates, 2);
  held(); hold = false;
  await page.locator('#create-thread-submit').click();
  await page.waitForFunction(() => state.detail?.thread.title === '超时恢复验证');
  assert.equal(creates, 2, 'recovering a late receipt must not create a duplicate thread');
  for (const [width, height] of [[375, 812], [390, 844], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    if (await page.locator('[data-action="back"]').isVisible()) await page.locator('[data-action="back"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(artifacts, `inbox-${width}.png`) });
    await page.locator('#new-thread-button').click();
    assert.equal(await page.evaluate(() => document.getElementById('new-thread-dialog').scrollWidth > document.getElementById('new-thread-dialog').clientWidth), false);
    await page.keyboard.press('Escape');
  }
  ws.close(); await once(ws, 'close');
  await page.waitForFunction(() => document.getElementById('new-thread-button').disabled);
  assert.deepEqual(errors, []);
  const report = { passed: true, verifiedAt: new Date().toISOString(), noRealModelCalls: true, checked: [
    'completed-and-interrupted-status', 'recent-24h-unread-baseline', 'unread-only-filter', 'viewed-final-marks-read',
    'read-state-survives-refresh', 'new-result-toast', 'create-project-thread', 'empty-thread-first-message',
    'late-create-receipt-no-duplicate', 'offline-disables-create', '375-390-1440-no-overflow'], pageErrors: errors };
  writeFileSync(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report));
} catch (error) { await page.screenshot({ path: join(artifacts, 'failure.png') }); throw error; }
finally { await browser.close(); ws.terminate(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
