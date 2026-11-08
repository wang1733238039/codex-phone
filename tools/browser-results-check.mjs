import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import WebSocket from 'ws';
import { createApp } from '../src/server.mjs';
import { ResultFiles } from '../src/result-files.mjs';
import { hashPassword } from '../src/config.mjs';
import { TRANSCRIPT_VERSION } from '../src/transcript.mjs';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const directory = mkdtempSync(join(tmpdir(), 'phone-result-browser-')), artifacts = resolve('artifacts/results');
mkdirSync(artifacts, { recursive: true });
const cwd = join(directory, 'workspace'); mkdirSync(cwd);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aXyUAAAAASUVORK5CYII=', 'base64');
writeFileSync(join(cwd, '返回图片.png'), png);
writeFileSync(join(cwd, '中文表格.csv'), '\uFEFF项目,金额,备注\r\n测试,123,"第一行\n第二行"\r\n安全,456,<script>window.injection=1</script>\r\n', 'utf8');
writeFileSync(join(cwd, '结果说明.md'), '# 返回文档\n\n正文可阅读。\n\n| 项目 | 说明 |\n|---|---|\n| 中文 | 完整内容 |\n\n<script>window.injection=2</script>', 'utf8');
writeFileSync(join(cwd, 'unsupported.docx'), 'download-only', 'utf8');
const module = { exports: {} };
runInNewContext(readFileSync(new URL('../public/vendor/xlsx.full.min.js', import.meta.url), 'utf8'), {
  module, exports: module.exports, Buffer, TextDecoder, TextEncoder, console,
});
const XLSX = module.exports, workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(Array.from({ length: 220 }, (_, row) =>
  Array.from({ length: 40 }, (_, column) => row === 0 ? `列${column + 1}` : `中文${row}-${column}`))), '汇总表');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['名称', '金额'], ['第二张表', 99]]), '明细');
const xlsx = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
writeFileSync(join(cwd, '多工作表.xlsx'), xlsx);
const threadId = randomUUID(), otherId = randomUUID(), actions = [], token = randomUUID();
const details = new Map([[threadId, { id: threadId, transcriptVersion: TRANSCRIPT_VERSION, running: false, turnStatus: 'completed',
  messages: [{ id: 'user', role: 'user', text: '展示返回文件', time: new Date().toISOString() },
    { id: 'answer', role: 'assistant', phase: 'final_answer', time: new Date().toISOString(), text:
      '| 项目 | 很长的第二列标题 | 第三列标题 | 第四列标题 | 第五列标题 |\n|---|---|---|---|---|\n| 中文 | 长内容长内容长内容 | 1234567890 | 对比说明 | 完整数据 |\n\n' +
      '[打开CSV](./中文表格.csv)\n\n[打开Excel](./多工作表.xlsx)\n\n![结果图](./返回图片.png)\n\n[阅读说明](./结果说明.md)\n\n[其他文件](./unsupported.docx)\n\n[已删除](./missing.txt)\n\n' +
      '[越界文件](../outside.txt)\n\n<img src="https://invalid.example/leak.png" onerror="window.injection=3">' }] }],
  [otherId, { id: otherId, transcriptVersion: TRANSCRIPT_VERSION, messages: [] }]]);
const files = new ResultFiles(async id => ({ detail: details.get(id) || { messages: [] }, cwd }));
const app = createApp({ database: join(directory, 'cache.sqlite'), username: 'admin', passwordHash: hashPassword('test-pass'),
  agentToken: token, controlsEnabled: true });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: `Bearer ${token}` } });
await once(ws, 'open');
ws.on('message', async raw => {
  const message = JSON.parse(raw); if (message.type !== 'request') return;
  actions.push(message.action);
  try {
    let data;
    if (message.action === 'models') data = { models: [] };
    else if (message.action === 'detail') data = files.descriptors(message.data.threadId, details.get(message.data.threadId));
    else if (message.action === 'result-file-info') data = await files.info(message.data);
    else if (message.action === 'result-file-chunk') data = await files.chunk(message.data);
    else throw new Error('Test must never submit or alter a task');
    ws.send(JSON.stringify({ type: 'response', id: message.id, data }));
  } catch (error) { ws.send(JSON.stringify({ type: 'response', id: message.id, error: error.message })); }
});
const snapshot = () => ws.send(JSON.stringify({ type: 'snapshot',
  threads: [threadId, otherId].map(id => ({ id, title: id === threadId ? '返回文件手机验收' : '另一会话', cwd, local: true, archived: false })),
  info: { controls: true, version: '0.6.12', capabilities: { resultFiles: true } } }));
snapshot();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await context.newPage(), errors = [], unexpected = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith(origin)) unexpected.push(request.url()); });
async function openFile(name) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.locator('#result-preview-dialog').waitFor({ state: 'visible' });
}
async function closeFile() { await page.getByRole('button', { name: '关闭文件预览' }).click(); }
try {
  await page.goto(origin); await page.locator('#password').fill('test-pass'); await page.locator('#login-button').click();
  await page.locator('.thread-row').first().waitFor();
  await page.evaluate(id => openThread(id), threadId);
  await page.getByRole('button', { name: '打开Excel', exact: true }).waitFor();
  assert.equal(actions.some(action => action.startsWith('result-file-')), false, 'opening a chat must not transfer result files');
  assert.equal(await page.locator('.message-body img').count(), 0, 'HTML cannot load remote or active image content');
  await page.getByRole('button', { name: '放大表格', exact: true }).click();
  await page.locator('#result-preview-body table').waitFor();
  assert.match(await page.locator('#result-preview-body').innerText(), /完整数据/);
  await page.screenshot({ path: join(artifacts, 'mobile-markdown-table.png') });
  await closeFile();
  await openFile('打开CSV');
  await page.locator('#result-preview-body td').first().waitFor();
  assert.match(await page.locator('#result-preview-body').innerText(), /第二行/);
  assert.match(await page.locator('#result-preview-body').innerText(), /<script>/);
  assert.equal(await page.evaluate(() => window.injection), undefined);
  await closeFile();
  await openFile('打开Excel');
  await page.locator('#result-preview-body td').first().waitFor();
  assert.equal(await page.locator('#result-preview-body tr').count(), 200);
  assert.equal(await page.locator('#result-preview-body tr').first().locator('td').count(), 30);
  assert.match(await page.locator('#result-preview-note').innerText(), /220 行/);
  assert.equal(await page.locator('#result-preview-body').evaluate(node => node.scrollWidth > node.clientWidth), true);
  await page.locator('#result-sheet-select').selectOption('1');
  assert.match(await page.locator('#result-preview-body').innerText(), /第二张表/);
  await page.screenshot({ path: join(artifacts, 'mobile-excel-sheet.png') });
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#result-preview-download').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), '多工作表.xlsx');
  const downloaded = join(artifacts, 'downloaded.xlsx'); await download.saveAs(downloaded);
  assert.deepEqual(readFileSync(downloaded), Buffer.from(xlsx));
  await closeFile();
  await page.getByRole('button', { name: '图片：结果图', exact: true }).click();
  await page.locator('#attachment-preview-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('attachment-preview-image').naturalWidth > 0 &&
    !document.getElementById('attachment-preview-image').hidden);
  assert.equal(await page.locator('#attachment-preview-image').getAttribute('alt'), '返回图片.png');
  await page.locator('#attachment-preview-zoom').click();
  assert.equal(await page.locator('#attachment-preview-zoom').getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: join(artifacts, 'mobile-returned-image.png') });
  await page.keyboard.press('Escape');
  await openFile('阅读说明'); await page.locator('#result-preview-body h1').waitFor();
  assert.match(await page.locator('#result-preview-body').innerText(), /正文可阅读/);
  assert.equal(await page.locator('#result-preview-body script').count(), 0); await closeFile();
  await openFile('其他文件'); await page.locator('.result-empty').waitFor(); await closeFile();
  await openFile('已删除'); await page.locator('.result-error').waitFor();
  assert.match(await page.locator('.result-error').innerText(), /移动或删除/);
  assert.equal(await page.locator('#result-preview-retry').isVisible(), true); await closeFile();
  await openFile('越界文件'); await page.locator('.result-error').waitFor(); await closeFile();
  for (const width of [320, 390, 760, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no page overflow at ${width}`);
  }
  const id = files.descriptors(threadId, details.get(threadId)).messages[1].resultFiles[0].id;
  const base = `/api/devices/${app.store.primaryDeviceId}/threads/${threadId}/results/${id}`;
  assert.equal((await fetch(origin + base)).status, 401, 'anonymous downloads fail');
  assert.equal((await context.request.get(origin + base.replace(threadId, otherId))).status(), 409, 'another thread cannot read the resource');
  const isolated = await browser.newContext();
  try {
    const registered = await isolated.request.post(origin + '/api/register', {
      headers: { Origin: origin }, data: { username: 'result-isolation', password: 'independent-test-password' },
    });
    assert.equal(registered.status(), 201);
    assert.equal((await isolated.request.get(origin + base)).status(), 404, 'another account cannot read the resource');
  } finally { await isolated.close(); }
  const pairing = randomUUID(); app.store.pairing(pairing, Date.now() + 10000);
  const otherDevice = app.store.claim(pairing, '另一电脑', randomUUID());
  app.store.snapshot([{ id: threadId, title: '同编号会话', local: true }], null, otherDevice.id);
  assert.equal((await context.request.get(origin + base.replace(app.store.primaryDeviceId, otherDevice.id))).status(), 503,
    'an offline target must never fall back to the online computer');
  const badHash = await context.request.get(origin + base + '/content?hash=' + 'a'.repeat(64));
  assert.equal(badHash.status(), 409);
  await page.evaluate(id => openThread(id), otherId);
  assert.equal(await page.locator('#result-preview-dialog').isVisible(), false);
  await page.evaluate(id => openThread(id), threadId);
  ws.terminate();
  await page.waitForFunction(() => !state.status.online);
  await openFile('打开CSV'); await page.locator('.result-error').waitFor();
  assert.match(await page.locator('.result-error').innerText(), /离线/);
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  assert.equal(actions.some(action => /send|queue|stop|approve|start/.test(action)), false, 'viewing never changes tasks');
  const report = { passed: true, realLocalFiles: true, markdownTable: true, csv: true, xlsx: true, sheetSwitch: true,
    boundedPreview: true, imageZoom: true, markdownFile: true, exactDownload: true, unicodeFilename: true,
    missingFile: true, offline: true, noEagerTransfer: true, threadIsolation: true, anonymousRejected: true,
    accountIsolation: true, deviceIsolation: true, changedHashRejected: true, noExternalRequests: true, noTaskWrites: true, consoleErrors: errors };
  writeFileSync(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} finally {
  await browser.close(); ws.terminate(); await app.close();
  assert.ok(directory.startsWith(join(tmpdir(), 'phone-result-browser-')));
  rmSync(directory, { recursive: true, force: true });
}
