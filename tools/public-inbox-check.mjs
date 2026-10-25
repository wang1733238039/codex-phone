// Deployment smoke check: static release integrity and read-only mobile UI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig } from '../src/config.mjs';

const origin = new URL(process.env.PHONE_ORIGIN || 'http://127.0.0.1:3819').origin;
const config = loadConfig('agent');
const deviceId = process.env.PHONE_DEVICE_ID || config.deviceId;
assert.ok(deviceId, 'Set PHONE_DEVICE_ID to the verified local-computer device ID for legacy configurations.');
assert.equal(new URL(config.serverUrl).origin, origin, 'Use the matching remote agent configuration.');
const directory = resolve(ROOT, 'artifacts/inbox/public');
mkdirSync(directory, { recursive: true });
const files = ['index.html', 'styles.css', 'conversation.css', 'app.js', 'inbox.js', 'attachments.js',
  'device-icons.svg', 'downloads/codex-phone-agent.zip', 'downloads/CONNECT-ANOTHER-COMPUTER.md'];
const assets = await Promise.all(files.map(async file => {
  const route = file === 'index.html' ? '/' : `/${file}`;
  const response = await fetch(`${origin}${route}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, file);
  const actual = Buffer.from(await response.arrayBuffer());
  const expected = readFileSync(resolve(ROOT, 'public', file));
  const hash = data => createHash('sha256').update(data).digest('hex');
  assert.equal(hash(actual), hash(expected), `Deployed file differs: ${file}`);
  return { file, bytes: actual.length, sha256: hash(actual) };
}));

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const password = readFileSync(resolve(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
  await page.goto(`${origin}/#/devices/${deviceId}`);
  await page.locator('#password').fill(password);
  await page.locator('#login-button').click();
  await page.waitForFunction(id => state.deviceId === id && state.status.online &&
    state.status.capabilities?.createThread && document.querySelector('.thread-row'), deviceId);
  const listing = await page.evaluate(() => ({
    threadCount: state.threads.length,
    resultCount: state.threads.filter(hasUnreadResult).length,
    withActivity: state.threads.filter(t => t.activity).length,
    expectedUnread: state.threads.filter(hasUnreadResult)
      .sort((a, b) => b.activity.resultAt - a.activity.resultAt).map(t => t.id),
    knownStates: [...new Set(state.threads.map(t => t.activity?.state))].sort(),
    projectOptions: state.projects.reduce((count, project) => count + project.rootPaths.length, 0) + 1
  }));
  assert.ok(listing.threadCount > 0);
  assert.equal(listing.withActivity, listing.threadCount);
  assert.equal(Number(await page.locator('#unread-count').innerText()), listing.resultCount);
  await page.locator('#unread-results').click();
  const unreadIds = await page.locator('.thread-row').evaluateAll(rows => rows.map(row => row.dataset.threadId));
  assert.deepEqual(unreadIds, listing.expectedUnread);
  await page.screenshot({ path: resolve(directory, 'unread-results-390.png') });
  await page.locator('[data-result-filter="all"]').click();
  await page.locator('#new-thread-button').click();
  await page.locator('#new-thread-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#new-thread-project option').count(), listing.projectOptions);
  assert.match(await page.locator('#new-thread-project option').last().innerText(), /无项目/);
  assert.equal(await page.locator('#new-thread-name').getAttribute('maxlength'), '120');
  assert.equal(await page.locator('#create-thread-submit').isEnabled(), true);
  const viewports = [];
  for (const [width, height] of [[390, 844], [375, 812], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const bounds = await page.locator('#new-thread-dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height + 1);
    viewports.push(`${width}x${height}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(directory, 'new-thread-dialog-390.png') });
  await page.locator('[aria-label="关闭新建对话"]').click();
  assert.equal(await page.locator('#new-thread-button').evaluate(node => document.activeElement === node), true);
  assert.deepEqual(errors, []);
  const report = { passed: true, verifiedAt: new Date().toISOString(), origin, deviceId,
    assets, listing, viewports, pageErrors: errors,
    checked: ['deployed-asset-and-connector-hashes', 'result-count', 'unread-newest-first',
      'native-project-dialog', 'projectless-option', 'mobile-dialog-bounds', 'dialog-focus-restored'] };
  writeFileSync(resolve(directory, 'release-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
