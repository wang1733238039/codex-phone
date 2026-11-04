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
import { listenForFetch } from '../test/helpers/http.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'phone-child-browser-')), artifacts = resolve('artifacts/children');
mkdirSync(artifacts, { recursive: true });
const app = createApp({ database: join(dir, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword('local-test-password'),
  agentToken: 'child-test-agent', controlsEnabled: true });
const origin = await listenForFetch(app.server), now = Date.now();
const root = randomUUID(), child = randomUUID(), nested = randomUUID(), child2 = randomUUID(), missing = randomUUID(), plain = randomUUID();
const common = { local: true, archived: false, projectId: 'p', projectName: '开发项目', updatedAt: now };
const roots = [
  { ...common, id: root, title: '手机端子对话切换', childCount: 3, activity: { state: 'completed' } },
  { ...common, id: plain, title: '普通独立会话', activity: { state: 'idle' } },
];
const children = [
  { ...common, id: child, parentThreadId: root, title: '子对话 1 · 检查连接链路', createdAt: now - 3000, activity: { state: 'completed' } },
  { ...common, id: nested, parentThreadId: child, title: '嵌套子对话 · 核对缓存', createdAt: now - 2000, activity: { state: 'unconfirmed' } },
  { ...common, id: child2, parentThreadId: root, title: '子对话 2 · 手机界面检查', createdAt: now - 1000, activity: { state: 'failed' } },
  { ...common, id: missing, parentThreadId: root, title: '历史文件未在此电脑', historyAvailable: false, createdAt: now, activity: { state: 'unknown' } },
];
const mainMessages = Array.from({ length: 32 }, (_, i) => ({
  id: `main-${i}`, role: i % 2 ? 'assistant' : 'user', ...(i % 2 ? { phase: 'final_answer' } : {}),
  text: i % 2 ? `第 ${i} 项检查已完成。切换子对话后，主对话的阅读位置和未发送草稿会保留。` : `请检查第 ${i} 项功能，并给出结果。`,
  time: new Date(now - (32 - i) * 1000).toISOString(),
}));
const details = new Map([
  [root, mainMessages],
  [plain, []],
  [child, [{ role: 'user', text: '检查电脑连接与子对话读取。' },
    { role: 'assistant', phase: 'final_answer', text: '连接链路已检查，子对话结果可以读取。' },
    { role: 'assistant', phase: 'commentary', text: 'HIDDEN_PROGRESS' }, { role: 'tool', text: 'HIDDEN_TOOL' }]],
  [nested, [{ role: 'assistant', phase: 'final_answer', text: '嵌套子对话的缓存检查结果。' }]],
  [child2, [{ role: 'assistant', phase: 'final_answer', text: '手机界面检查已返回，任务状态保留为失败。' }]],
]);
const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: 'Bearer child-test-agent' } });
await once(ws, 'open');
let delayChild = false, heldChild, forwardedControls = 0, childControls = false;
ws.on('message', raw => {
  const msg = JSON.parse(raw); if (msg.type !== 'request') return;
  const reply = data => ws.send(JSON.stringify({ type: 'response', id: msg.id, data }));
  if (msg.action === 'models') return reply({ models: [] });
  if (msg.action === 'detail') {
    if (msg.data.threadId === missing) return ws.send(JSON.stringify({ type: 'response', id: msg.id, error: '会话文件不在此电脑，无法读取该历史' }));
    const data = { id: msg.data.threadId, transcriptVersion: 2, messages: details.get(msg.data.threadId) || [],
      running: false, turnStatus: 'completed' };
    if (delayChild && msg.data.threadId === child2) { heldChild = () => reply(data); return; }
    return reply(data);
  }
  forwardedControls++;
  if (msg.action === 'create-thread') {
    const thread = { ...common, id: randomUUID(), title: msg.data.title, parentThreadId: msg.data.parentThreadId, rootThreadId: root, depth: 2 };
    children.push(thread); details.set(thread.id, []); snapshot(); return reply({ thread });
  }
  reply({ delivery: 'started' });
});
function snapshot() {
  ws.send(JSON.stringify({ type: 'snapshot', threads: roots, childThreads: children,
    sidebar: { version: 1, projects: [{ id: 'p', name: '开发项目', expanded: true }] },
    info: { computer: '4090', controls: true, capabilities: { childThreads: true, childControls, createThread: true, models: true, attachments: true } } }));
}
snapshot();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const report = { viewports: [], checks: [] };
const check = name => report.checks.push(name);
const select = async id => {
  await page.locator('#family-button').click();
  await page.locator(`[data-family-thread-id="${id}"]`).click();
  await page.waitForFunction(id => state.selected === id && state.detail?.id === id, id);
};
try {
  await page.goto(origin); await page.locator('#password').fill('local-test-password'); await page.locator('#login-button').click();
  await page.locator(`[data-thread-id="${root}"]`).waitFor();
  assert.equal(await page.locator('.thread-row').count(), 2); check('children excluded from main list');
  await page.locator(`[data-thread-id="${root}"]`).click();
  await page.waitForFunction(id => state.detail?.id === id && state.family?.threads.length === 5, root);
  const headerHeight = await page.locator('.chat-header').evaluate(node => node.getBoundingClientRect().height);
  assert.ok(headerHeight <= 110, `header too tall: ${headerHeight}`);
  await page.locator('#message').fill('主会话未发送的草稿');
  await page.locator('#messages').evaluate(node => { node.scrollTop = 260; });
  const scrollBefore = await page.locator('#messages').evaluate(node => node.scrollTop);
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 }); await page.locator('#family-button').click();
    const size = await page.evaluate(() => {
      const dialog = document.getElementById('family-dialog').getBoundingClientRect(), button = document.getElementById('family-button').getBoundingClientRect();
      return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, dialogWidth: dialog.width, dialogHeight: dialog.height, touchHeight: button.height };
    });
    assert.equal(size.overflow, false); assert.ok(size.touchHeight >= 44); assert.ok(size.dialogWidth <= width);
    assert.ok(size.dialogHeight <= 844 * 0.82); report.viewports.push(size);
    assert.equal(await page.locator('.family-choice').count(), 5);
    await page.screenshot({ path: join(artifacts, `picker-${width}.png`) });
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#family-dialog').isVisible(), false);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#messages').evaluate((node, value) => { node.scrollTop = value; }, scrollBefore);
  // The picker reports live connector changes without rebuilding the main sidebar.
  await page.locator('#family-button').click();
  children[0].activity.state = 'failed'; snapshot();
  await page.locator(`[data-family-thread-id="${child}"] .result-badge`).filter({ hasText: '失败' }).waitFor();
  children[0].activity.state = 'completed'; snapshot();
  await page.locator(`[data-family-thread-id="${child}"] .result-badge`).filter({ hasText: '已完成' }).waitFor();
  await page.keyboard.press('Escape'); check('child status changes refresh the open picker');
  await select(child);
  assert.equal(await page.locator('#composer-wrap').isVisible(), false);
  assert.equal(await page.locator('#child-readonly').isVisible(), true);
  assert.equal(await page.locator('#message').isDisabled(), true);
  assert.equal(await page.locator('#attach-button').isDisabled(), true);
  assert.equal(await page.locator('#messages').innerText().then(text => /HIDDEN_PROGRESS|HIDDEN_TOOL/.test(text)), false);
  await page.screenshot({ path: join(artifacts, 'child-390.png') });
  check('child content has final replies only and composer disabled');
  await select(nested); assert.match(await page.locator('#messages').innerText(), /嵌套子对话的缓存/); check('nested switching');
  await page.locator('#return-main-thread').click(); await page.waitForFunction(id => state.detail?.id === id, root);
  assert.equal(await page.locator('#message').inputValue(), '主会话未发送的草稿');
  const scrollAfter = await page.locator('#messages').evaluate(node => node.scrollTop);
  assert.ok(Math.abs(scrollAfter - scrollBefore) <= 3, `reading position changed ${scrollBefore} -> ${scrollAfter}`);
  check('main draft and reading position restored');
  await select(child); const childUrl = page.url();
  await page.reload(); await page.waitForFunction(id => state.detail?.id === id, child);
  assert.equal(page.url(), childUrl); assert.match(await page.locator('#messages').innerText(), /连接链路已检查/);
  check('direct child URL reload');
  await select(root); await select(child);
  await page.goBack(); await page.waitForFunction(id => state.detail?.id === id, root);
  check('browser back navigation');
  delayChild = true;
  await page.locator('#family-button').click(); await page.locator(`[data-family-thread-id="${child2}"]`).click();
  await page.waitForFunction(id => state.selected === id, child2);
  await page.locator('#family-button').click(); await page.locator(`[data-family-thread-id="${child}"]`).click();
  await page.waitForFunction(id => state.detail?.id === id, child);
  while (!heldChild) await new Promise(r => setTimeout(r, 20));
  heldChild(); delayChild = false;
  await page.waitForTimeout(100);
  assert.match(await page.locator('#messages').innerText(), /连接链路已检查/);
  assert.doesNotMatch(await page.locator('#messages').innerText(), /手机界面检查已返回/);
  check('late child response cannot replace selected conversation');
  await page.route('**/family', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试断连' }) }));
  await page.locator('#family-button').click(); await page.getByText('读取失败：测试断连').waitFor();
  assert.equal(await page.locator('.family-choice').count(), 5);
  await page.unroute('**/family'); await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.getByText('读取失败：测试断连').waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape'); check('family error retains last list and supports retry');
  await page.locator('#family-button').click(); await page.locator(`[data-family-thread-id="${missing}"]`).click();
  await page.getByText('会话文件不在此电脑，无法读取该历史', { exact: true }).waitFor();
  assert.equal(await page.locator('#child-readonly').isVisible(), true);
  await page.locator('#return-main-thread').click(); await page.waitForFunction(id => state.detail?.id === id, root);
  await select(child); check('missing local history explains the problem and can return to main');
  childControls = true; snapshot();
  await page.waitForFunction(() => state.status.capabilities.childControls);
  await page.locator('#message').fill('手机子对话追加消息');
  await page.locator('#send-button').click();
  await page.waitForFunction(() => !document.getElementById('message').value);
  assert.equal(await page.locator('#composer-wrap').isVisible(), true);
  check('upgraded connector accepts direct child message');
  await page.locator('#family-button').click(); await page.locator('#create-child').click();
  await page.waitForFunction(ids => state.selected !== ids.child && state.detail?.id === state.selected, { child });
  assert.equal(await page.locator('#message').isDisabled(), false);
  check('native child creation opens editable child');
  await select(child);
  ws.close(); await once(ws, 'close');
  await page.reload(); await page.waitForFunction(id => state.detail?.id === id && !state.status.online, child);
  assert.match(await page.locator('#messages').innerText(), /连接链路已检查/);
  assert.equal(await page.locator('#family-button').isVisible(), true); check('offline cached child read and switching');
  await page.locator('[data-action="back"]').click();
  await page.locator(`[data-thread-id="${plain}"]`).click();
  assert.equal(await page.locator('#family-button').isVisible(), true);
  await page.locator('#family-button').click();
  assert.equal(await page.locator('#create-child').isDisabled(), true);
  check('empty family keeps entry and offline creation disabled');
  assert.equal(forwardedControls, 2); assert.deepEqual(errors, []);
  const contrast = await page.evaluate(() => {
    function luminance(rgb) {
      const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => { const v = n / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
      return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
    }
    const cases = [['#family-button', '#family-button'], ['.family-note', '#family-dialog'], ['#child-readonly', 'body']];
    return cases.map(([a, b]) => {
      const fg = luminance(getComputedStyle(document.querySelector(a)).color);
      const bg = luminance(getComputedStyle(document.querySelector(b)).backgroundColor);
      return { selector: a, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) };
    });
  });
  for (const item of contrast) assert.ok(item.ratio >= 4.5, `${item.selector} contrast ${item.ratio}`);
  report.contrast = contrast;
  report.consoleErrors = errors; report.forwardedControls = forwardedControls; report.headerHeight = headerHeight;
  writeFileSync(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close(); ws.terminate(); await app.close(); rmSync(dir, { recursive: true, force: true });
}
