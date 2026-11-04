import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient, resolveCodexBin } from '../src/codex.mjs';

function processFixture(failure = false) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.kill = () => { queueMicrotask(() => { proc.closed = true; proc.emit('exit', 0); proc.emit('close', 0); }); };
  if (failure) queueMicrotask(() => {
    const error = new Error('spawn codex ENOENT'); error.code = 'ENOENT';
    proc.emit('error', error); proc.closed = true; proc.emit('close', -1);
  });
  else proc.stdin.on('data', raw => {
    for (const line of raw.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      if (message.id) queueMicrotask(() => proc.stdout.write(JSON.stringify({ id:message.id,
        result:message.method === 'model/list' ? {data:[{model:'fixture-model'}]} : {} }) + '\n'));
    }
  });
  return proc;
}
test('a failed binary spawn cannot permanently block later model reads behind a missing close event', async () => {
  let attempts = 0;
  const client = new CodexClient({codexHome:tmpdir()}, () => processFixture(++attempts === 1));
  await assert.rejects(client.start(), /ENOENT/);
  client.close(); // The failed child already emitted close, without an exit event.
  await client.start();
  assert.equal((await client.call('model/list', {})).data[0].model, 'fixture-model');
  assert.equal(attempts,2);
  client.close(); await client.stopping;
});
test('old process exit events do not clear a replacement runtime or reject its reads', async () => {
  const first = processFixture(true), second = processFixture();
  let count=0;
  const client = new CodexClient({codexHome:tmpdir()},()=>++count===1 ? first : second);
  await assert.rejects(client.start());
  await client.start();
  first.emit('exit', -1);
  assert.equal(client.proc,second);
  assert.equal((await client.call('model/list',{})).data.length,1);
  client.close();await client.stopping;
});
test('Windows desktop binary discovery recovers removed version folders and preserves explicit custom binaries', () => {
  const dir=mkdtempSync(join(tmpdir(),'phone-binary-'));
  try {
    const folder=join(dir,'OpenAI','Codex','bin','current');
    mkdirSync(folder,{recursive:true});const current=join(folder,'codex.exe');writeFileSync(current,'fixture');
    const options={platform:'win32',localAppData:dir};
    assert.equal(resolveCodexBin('codex',options),current);
    assert.equal(resolveCodexBin(join(dir,'OpenAI','Codex','bin','removed','codex.exe'),options),current);
    assert.equal(resolveCodexBin(join(dir,'custom','codex.exe'),options),join(dir,'custom','codex.exe'));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
