import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/config.mjs';
import { listenForFetch } from '../test/helpers/http.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'phone-sync-browser-'));
const app = createApp({ database: join(dir, 'cache.sqlite'), username: 'admin',
  passwordHash: hashPassword('sync-fixture-only'), agentToken: 'sync-fixture-agent', controlsEnabled: true });
const origin = await listenForFetch(app.server);
const first = randomUUID(), second = randomUUID();
const ws = new WebSocket(origin.replace('http', 'ws') + '/agent', { headers: { Authorization: 'Bearer sync-fixture-agent' } });
await once(ws, 'open');
let delay = 2000, revision = 1, forwardedControls = 0, outstanding = 0, maximumOutstanding = 0, modelReads = 0;
const timers = new Set();
ws.on('message', raw => {
  const msg = JSON.parse(raw);
  if (msg.type !== 'request') return;
  if (msg.action === 'models') {
    modelReads++;
    return ws.send(JSON.stringify({type:'response',id:msg.id,...(modelReads === 1
      ? {error:'Fixture model service unavailable'}
      : {data:{models:[{id:'fixture-model',name:'Fixture model',efforts:['low','high']}]}})}));
  }
  if (msg.action !== 'detail') { forwardedControls++; return; }
  outstanding++; maximumOutstanding = Math.max(maximumOutstanding, outstanding);
  const captured = revision;
  const timer = setTimeout(() => {
    timers.delete(timer); outstanding--;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({type:'response',id:msg.id,data:{
      id:msg.data.threadId, transcriptVersion:2, running:false, turnStatus:'completed',
      messages:[{id:`${msg.data.threadId}-${captured}`,role:'assistant',phase:'final_answer',
        text:`SYNC_RESULT_${msg.data.threadId}_${captured}`,time:new Date().toISOString()}],
    }}));
  }, delay);
  timers.add(timer);
});
ws.send(JSON.stringify({type:'snapshot',threads:[first,second].map((id,index)=>({
  id,title:`Sync fixture ${index}`,local:true,archived:false,updatedAt:Date.now(),
})),info:{controls:true,computer:'Sync fixture'}}));
const browser = await chromium.launch({headless:true,channel:'msedge'});
const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
const page = await context.newPage(), errors = [];
page.on('pageerror', error=>errors.push(error.message));
// An unauthenticated bootstrap response can arrive after the user logs in.
let bootstrapCaptured;
const bootstrapReady = new Promise(resolve=>bootstrapCaptured=resolve);
await page.route('**/api/session',async route=>{
  const response=await route.fetch();
  if (!(await response.json()).authenticated) {
    bootstrapCaptured();
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  await route.fulfill({response});
});
if (process.env.SYNC_APP_FILE) {
  const script = readFileSync(process.env.SYNC_APP_FILE, 'utf8');
  await page.route('**/app.js', route=>route.fulfill({contentType:'text/javascript; charset=utf-8',body:script}));
}
let burst;
try {
  await page.goto(origin);
  await bootstrapReady;
  await page.evaluate(()=>{ document.getElementById('login-view').hidden=false; });
  await page.locator('#password').fill('sync-fixture-only');
  await page.locator('#login-button').click();
  await page.locator(`[data-thread-id="${first}"]`).waitFor();
  await page.evaluate(()=>clearInterval(polling));
  burst=setInterval(()=>ws.send(JSON.stringify({type:'changed',threadId:first})),100);
  await page.locator(`[data-thread-id="${first}"]`).click();
  await page.waitForFunction(id=>state.detail?.id===id && document.getElementById('messages').textContent.includes('SYNC_RESULT_'),first,{timeout:6500});
  assert.equal(await page.locator('#login-view').isVisible(),false,'a late logged-out bootstrap must not erase a successful login');
  assert.equal(maximumOutstanding,1,'rapid changes must share the in-flight read');
  await page.locator('#message').fill('UNSENT_SYNC_DRAFT');
  revision=2;
  await page.waitForFunction(id=>document.getElementById('messages').textContent.includes(`SYNC_RESULT_${id}_2`),first,{timeout:6500});
  assert.equal(await page.locator('#message').inputValue(),'UNSENT_SYNC_DRAFT');
  clearInterval(burst); burst=null;
  await page.locator('#composer-settings-button').click();
  await page.waitForFunction(()=>state.modelError.includes('Fixture'));
  assert.equal(await page.locator('#model-select').isDisabled(),true);
  await page.getByRole('button',{name:'刷新模型列表',exact:true}).click();
  await page.waitForFunction(()=>state.models.length===1);
  await page.locator('#model-select').selectOption('fixture-model');
  await page.locator('#effort-select').selectOption('high');
  assert.equal(await page.locator('#model-select').inputValue(),'fixture-model');
  assert.equal(await page.locator('#effort-select').inputValue(),'high');
  await page.locator('#composer-settings-dialog form[method="dialog"]').last().locator('button').click();

  // A response for a previous navigation must not populate another conversation.
  delay=900;
  await page.evaluate(()=>{ void loadDetail(true); });
  await page.evaluate(id=>{ void openThread(id); },second);
  await page.waitForFunction(id=>state.detail?.id===id,second,{timeout:4000});
  assert.ok((await page.locator('#messages').innerText()).includes(`SYNC_RESULT_${second}_2`));
  assert.ok(!(await page.locator('#messages').innerText()).includes(`SYNC_RESULT_${first}`));
  await page.evaluate(id=>{ void openThread(id); },first);
  await page.waitForFunction(id=>state.detail?.id===id,first,{timeout:4000});
  assert.equal(await page.locator('#message').inputValue(),'UNSENT_SYNC_DRAFT');

  // Transport failure preserves rendered history; a subsequent read catches up.
  await context.setOffline(true);
  await page.evaluate(()=>loadDetail(true));
  assert.ok((await page.locator('#messages').innerText()).includes(`SYNC_RESULT_${first}_2`));
  revision=3;
  await context.setOffline(false);
  await page.evaluate(()=>loadDetail(true));
  await page.waitForFunction(id=>document.getElementById('messages').textContent.includes(`SYNC_RESULT_${id}_3`),first,{timeout:4000});
  assert.equal(await page.locator('#message').inputValue(),'UNSENT_SYNC_DRAFT');
  assert.equal(forwardedControls,0,'read recovery must not submit model tasks');
  assert.deepEqual(errors,[]);
  assert.equal(await page.locator('#model-select').inputValue(),'fixture-model');
  console.log(JSON.stringify({passed:true,checks:['late-session-bootstrap-isolation','rapid-change-no-starvation','coalesced-read','model-failure-retry','model-and-effort-select',
    'new-result-while-events-continue','draft-preserved','navigation-isolation','offline-history-preserved',
    'reconnect-catches-up','zero-model-submissions'],pageErrors:errors}));
} finally {
  clearInterval(burst);
  await browser.close();
  for (const timer of timers) clearTimeout(timer);
  ws.close();
  await app.close();
  rmSync(dir,{recursive:true,force:true});
}
