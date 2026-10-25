import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { ROOT } from '../src/config.mjs';

const runtime = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await context.newPage(), errors = [];
const target = process.argv[2];
const threadRow = () => target ? page.locator(`[data-thread-id="${target}"]`) : page.locator('.thread-row').first();
page.on('pageerror', error => errors.push(error.message));
const origin = process.env.PHONE_ORIGIN || 'http://127.0.0.1:3819';
const artifacts = resolve(ROOT, 'artifacts', process.env.PHONE_ORIGIN ? 'public-deploy' : '.'); mkdirSync(artifacts, { recursive: true });
try {
  await page.goto(origin); await page.locator('#login-view').waitFor({ state: 'visible' });
  await page.screenshot({ path: join(artifacts, 'phone-login.png') });
  const password = readFileSync(resolve(ROOT, '.data/login.md'), 'utf8').match(/`([^`]+)`/)[1];
  await page.locator('#password').fill(password); await page.locator('#login-button').click();
  await page.locator('.thread-row').first().waitFor({ state: 'visible', timeout: 30000 });
  const count = await page.locator('.thread-row').count(); assert.ok(count > 0);
  const listing = await page.evaluate(async () => (await fetch('/api/threads')).json());
  assert.ok(listing.sidebar.projects.length > 0);
  assert.deepEqual(await page.locator('.group-name').allTextContents(), listing.groups.map(g => g.name));
  const rowIds = await page.locator('[data-thread-id]').evaluateAll(rows => rows.map(r => r.dataset.threadId));
  assert.equal(new Set(rowIds).size, count); assert.equal(count, listing.threads.length);
  await page.locator('#collapse-groups').click();
  assert.equal(await page.locator('.thread-row:visible').count(), 0);
  await page.screenshot({ path: join(artifacts, 'phone-projects-collapsed.png') });
  await page.reload(); await page.locator('.group-toggle').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.thread-row:visible').count(), 0, 'fold choices persist after refresh');
  const group = listing.groups.find(g => g.kind === 'project' && g.threadIds.length);
  const toggle = page.locator(`[data-group-id="${group.id}"]`);
  await toggle.focus(); await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await toggle.evaluate(e => document.activeElement === e), true, 'toggle retains keyboard focus');
  assert.equal(await toggle.evaluate(e => e.getBoundingClientRect().height >= 44), true);
  await page.evaluate(() => loadList());
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'sync preserves fold choice');
  assert.equal(await toggle.evaluate(e => document.activeElement === e), true, 'sync preserves group focus');
  await page.locator('#search').fill(group.name);
  await page.waitForFunction(name => document.getElementById('search').value === name && document.getElementById('group-summary').textContent.includes('搜索结果'), group.name);
  assert.ok(await page.locator('.thread-row:visible').count() >= group.threadIds.length);
  assert.equal(await page.locator('.group-toggle[aria-expanded="false"]').count(), 0);
  await page.locator('#search').fill('');
  await page.waitForFunction(() => !document.getElementById('collapse-groups').disabled);
  // Keep the project overview readable for the list screenshot, then open every
  // group so the existing history checks can select any target thread.
  if (await page.locator('#collapse-groups').innerText() === '全部收起') await page.locator('#collapse-groups').click();
  await page.screenshot({ path: join(artifacts, 'phone-list.png') });
  await page.locator('#collapse-groups').click();
  await page.locator('#search').fill('unlikely-test-no-match-832194'); await page.locator('.list-empty').waitFor({ state: 'visible' });
  assert.match(await page.locator('#thread-list').innerText(), /没有找到/);
  await page.locator('#search').fill(''); await page.locator('.thread-row').first().waitFor({ state: 'visible' });
  await Promise.all([page.waitForResponse(r => r.url().includes('/threads?archived=true') && r.status() === 200), page.locator('.mobile-nav [data-view="archived"]').click()]);
  await Promise.all([page.waitForResponse(r => r.url().includes('/threads?archived=false') && r.status() === 200), page.locator('.mobile-nav [data-view="recent"]').click()]);
  await threadRow().click(); await page.locator('.message').first().waitFor({ state: 'attached', timeout: 30000 });
  const transcript = await page.evaluate(async () => deviceApi(`/threads/${state.selected}`));
  assert.equal(transcript.transcriptVersion, 2);
  assert.ok(transcript.messages.every(m => m.role === 'user' || (m.role === 'assistant' && m.phase === 'final_answer')));
  assert.equal(await page.locator('#messages .message').count(), transcript.messages.length);
  await page.waitForFunction(() => document.getElementById('model-select').options.length > 1 &&
    !document.getElementById('model-select').disabled, null, { timeout: 30000 });
  assert.equal(await page.locator('#message').isEnabled(), true, 'no final answer is required to edit the next input');
  assert.ok((await page.locator('#execution-status').innerText()).length);
  assert.equal(await page.locator('#composer-settings-dialog').isVisible(), false, 'message settings stay out of the chat by default');
  assert.equal(await page.locator('#composer-settings-button').isVisible(), true);
  const compactComposer = await page.evaluate(() => ({
    inputHeight: document.getElementById('message').getBoundingClientRect().height,
    composerHeight: document.querySelector('.composer-wrap').getBoundingClientRect().height,
    viewportHeight: innerHeight
  }));
  assert.ok(compactComposer.inputHeight <= 56, `empty input should remain compact: ${JSON.stringify(compactComposer)}`);
  assert.ok(compactComposer.composerHeight <= 150, `composer should leave room for the transcript: ${JSON.stringify(compactComposer)}`);
  assert.ok(compactComposer.composerHeight / compactComposer.viewportHeight < 0.2, `composer should use less than 20% of the phone viewport: ${JSON.stringify(compactComposer)}`);
  assert.equal(await page.locator('#message').evaluate(e => getComputedStyle(e).resize), 'none');
  await page.locator('#composer-settings-button').click();
  assert.equal(await page.locator('#composer-settings-dialog').isVisible(), true);
  for (const id of ['#model-select', '#effort-select', '#send-mode']) assert.equal(await page.locator(id).isVisible(), true);
  await page.locator('#composer-settings-dialog button[type="submit"]').click();
  assert.equal(await page.locator('#composer-settings-dialog').isVisible(), false);
  const visibleRoles = await page.locator('#messages .message').evaluateAll(nodes => nodes.map(node => ({
    role: node.classList.contains('user') ? 'user' : node.classList.contains('assistant') ? 'assistant' : 'unknown',
    label: node.querySelector('.message-role')?.textContent
  })));
  assert.deepEqual(visibleRoles.filter(item => item.role === 'unknown'), []);
  assert.ok(visibleRoles.every(item => item.label === (item.role === 'user' ? '你 · 发送' : 'Codex · 回复')));
  assert.equal(visibleRoles.filter(item => item.role === 'user').length, transcript.messages.filter(m => m.role === 'user').length);
  assert.equal(visibleRoles.filter(item => item.role === 'assistant').length, transcript.messages.filter(m => m.role === 'assistant').length);
  await page.screenshot({ path: join(artifacts, 'phone-chat.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'phone horizontal overflow');
  assert.equal(await page.locator('#messages').evaluate(e => e.scrollHeight > 0), true);
  await page.locator('[data-action="back"]').click(); await page.locator('.mobile-nav [data-action="status"]').click();
  assert.equal(await page.locator('#status-dialog').isVisible(), true); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 812 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(artifacts, 'phone-375.png') });
  await page.setViewportSize({ width: 1440, height: 1000 }); await threadRow().click(); await page.locator('.message').first().waitFor({ state: 'attached' });
  await page.screenshot({ path: join(artifacts, 'desktop.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'desktop horizontal overflow');
  // Exercise sanitization and offline UI in a separate, mocked response without changing Codex data.
  await page.route('**/api/devices/*/threads/*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(), data = await response.json();
    data.messages = [
      { id: 'hidden-progress', role: 'assistant', text: 'HIDDEN_PROGRESS_SENTINEL', phase: 'commentary' },
      { id: 'hidden-reasoning', role: 'assistant', text: 'HIDDEN_REASONING_SENTINEL' },
      { id: 'hidden-tool', role: 'tool', text: 'HIDDEN_TOOL_SENTINEL' },
      { id: 'security-test', role: 'assistant', phase: 'final_answer', text: '<img src="https://evil.invalid/image" onerror="window.pwned=1"><script>window.pwned=2</script>[bad](javascript:alert(1))\n\n安全内容', time: new Date().toISOString() }
    ];
    data.online = false; data.running = false; data.total = 1; data.before = null;
    await route.fulfill({ response, json: data });
  });
  await page.locator('[data-action="refresh"]').click(); await page.waitForFunction(() => document.getElementById('messages').textContent.includes('安全内容'));
  assert.equal(await page.locator('#messages img, #messages script, #messages a[href^="javascript:"]').count(), 0);
  assert.doesNotMatch(await page.locator('#messages').innerText(), /HIDDEN_\w+_SENTINEL/);
  assert.equal(await page.locator('#messages .message').count(), 1);
  assert.equal(await page.evaluate(() => Boolean(window.pwned)), false); assert.equal(await page.locator('#send-button').isDisabled(), true);
  assert.equal(await page.locator('#cache-banner').isVisible(), true);
  await page.locator('.sidebar-footer [data-action="logout"]').click(); await page.locator('#login-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#messages').innerText(), '');
  assert.deepEqual(errors, []);
  const report = { passed: true, realVisibleThreadCount: count, projects: listing.sidebar.projects.length, pinned: listing.threads.filter(t => t.pinned).length, transcript: { id: transcript.id, total: transcript.total, visibleUsers: transcript.messages.filter(m => m.role === 'user').length, visibleFinals: transcript.messages.filter(m => m.role === 'assistant').length }, composer: compactComposer, visibleRoles, viewports: ['390x844', '375x812', '1440x1000'], checked: ['project-categories', 'no-duplicate-threads', 'collapse-all', 'fold-persistence', 'keyboard-toggle', 'focus-retention-on-sync', 'project-search-expands-matches', 'login', 'search-empty', 'archived-tab', 'real-history', 'final-only-transcript', 'hidden-progress-reasoning-tools', 'compact-composer', 'settings-dialog', 'clear-message-role-labels', 'live-model-selector', 'draft-without-final', 'execution-status', 'send-mode', 'mobile-back', 'status-dialog', 'no-overflow', 'markdown-xss', 'offline-disabled-send', 'logout-clears-transcript'], pageErrors: errors };
  writeFileSync(join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report));
} catch (error) { await page.screenshot({ path: join(artifacts, 'browser-failure.png') }); console.log(JSON.stringify({ pageErrors: errors, listError: await page.locator('#list-error').textContent(), messageCount: await page.locator('#messages .message').count() })); throw error; }
finally { await browser.close(); }
