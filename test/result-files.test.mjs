import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ResultFiles } from '../src/result-files.mjs';
import { localResultReference, resultReferences } from '../src/result-references.mjs';
import { validateResultInfo } from '../src/server-results.mjs';
import { CHUNK_BYTES } from '../src/attachment-common.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, reference = './中文结果.csv', content = Buffer.from('姓名,金额\n张三,10\n')) {
  const directory = mkdtempSync(join(tmpdir(), 'phone-results-'));
  const cwd = join(directory, 'workspace'); mkdirSync(cwd);
  const path = resolve(cwd, reference);
  if (reference.startsWith('./')) writeFileSync(path, content);
  const threadId = randomUUID(), detail = { messages: [{ id: 'final', role: 'assistant', phase: 'final_answer', text: `[结果](<${reference}>)` }] };
  const files = new ResultFiles(async id => {
    if (id !== threadId) throw new Error('different thread');
    return { cwd, detail };
  });
  const id = files.descriptors(threadId, detail).messages[0].resultFiles[0].id;
  t.after(() => {
    assert.ok(directory.startsWith(join(tmpdir(), 'phone-results-')));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, cwd, path, threadId, detail, files, id, content };
}
test('result extraction includes final Markdown paths, spaces, parentheses and reference links only', () => {
  const messages = [
    { role: 'user', text: '[secret](/outside/private.txt)' },
    { role: 'assistant', phase: 'commentary', text: '[tool](/outside/tool.txt)' },
    { role: 'assistant', phase: 'final_answer', text: [
      '[中文](<C:/作品/结果 表格.xlsx>)', '![图片](./图(一).png)',
      '[定位](./app.py:12)', '[ref][report]', '[report]: ./report.md',
      '```md', '[example](./example.txt)', '```', '`[code](./code.txt)`',
      '[web](https://example.com/image.png)',
    ].join('\n') },
  ];
  assert.deepEqual(resultReferences(messages).map(item => item.reference),
    ['C:/作品/结果 表格.xlsx', './图(一).png', './app.py:12', './report.md']);
  assert.equal(localResultReference('file:///C:/中文/a.png'), 'C:/中文/a.png');
  assert.equal(localResultReference('file://remote/share/a.png'), null);
  assert.equal(localResultReference('javascript:alert(1).png'), null);
});
test('real Unicode result metadata and bounded chunks reconstruct the exact file without path disclosure', async t => {
  const f = fixture(t, './中文结果.csv', Buffer.alloc(CHUNK_BYTES + 35, 65));
  const meta = await f.files.info(f);
  assert.equal(meta.name, '中文结果.csv'); assert.equal(meta.hash, digest(f.content));
  assert.equal(meta.path, undefined);
  const chunks = [];
  for (let offset = 0; offset < meta.size; offset += CHUNK_BYTES) {
    const part = await f.files.chunk({ ...f, offset, hash: meta.hash });
    chunks.push(Buffer.from(part.base64, 'base64'));
  }
  assert.deepEqual(Buffer.concat(chunks), f.content);
});
test('result access rechecks final-answer ownership, file changes and deletion', async t => {
  const f = fixture(t), meta = await f.files.info(f);
  await assert.rejects(f.files.info({ ...f, threadId: randomUUID() }), /different/);
  await assert.rejects(f.files.info({ ...f, id: 'a'.repeat(64) }), /不属于/);
  writeFileSync(f.path, 'changed', 'utf8');
  await assert.rejects(f.files.chunk({ ...f, offset: 0, hash: meta.hash }), /变化/);
  rmSync(f.path);
  await assert.rejects(f.files.info(f), /移动或删除/);
});
test('outside paths, private configuration and symlink escapes cannot become downloads', async t => {
  const f = fixture(t, '../outside.txt');
  writeFileSync(f.path, 'outside', 'utf8');
  await assert.rejects(f.files.info(f), /授权目录之外/);
  const privatePath = join(f.cwd, '.env.local');
  writeFileSync(privatePath, 'secret', 'utf8');
  f.detail.messages[0].text = '[private](./.env.local)';
  const privateId = f.files.descriptors(f.threadId, f.detail).messages[0].resultFiles[0].id;
  await assert.rejects(f.files.info({ ...f, id: privateId }), /私有配置/);
  const outside = join(f.directory, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'image.png'), 'outside target', 'utf8');
  symlinkSync(outside, join(f.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  f.detail.messages[0].text = '[escape](./escape/image.png)';
  const linkId = f.files.descriptors(f.threadId, f.detail).messages[0].resultFiles[0].id;
  await assert.rejects(f.files.info({ ...f, id: linkId }), /授权目录之外/);
});
test('changed final answers revoke stale resource ids and empty files download safely', async t => {
  const f = fixture(t, './empty.txt', Buffer.alloc(0));
  assert.equal((await f.files.info(f)).hash, digest(Buffer.alloc(0)));
  f.detail.messages[0].text = 'No file in this final answer';
  await assert.rejects(f.files.info(f), /不属于/);
});
test('private runtime files remain blocked even when an old final answer links them', async t => {
  const f = fixture(t);
  const privateDirectory = join(f.cwd, '.data'); mkdirSync(privateDirectory);
  writeFileSync(join(privateDirectory, 'login.md'), 'private test credential', 'utf8');
  writeFileSync(join(privateDirectory, 'agent.remote.json'), '{"private":true}', 'utf8');
  for (const reference of ['./.data/login.md', './.data/agent.remote.json']) {
    f.detail.messages[0].text = `[old setup reply](${reference})`;
    const id = f.files.descriptors(f.threadId, f.detail).messages[0].resultFiles[0].id;
    await assert.rejects(f.files.info({ ...f, id }), /私有配置/);
  }
  symlinkSync(privateDirectory, join(f.cwd, 'public-output'), process.platform === 'win32' ? 'junction' : 'dir');
  f.detail.messages[0].text = '[indirect](./public-output/login.md)';
  const linkedId = f.files.descriptors(f.threadId, f.detail).messages[0].resultFiles[0].id;
  await assert.rejects(f.files.info({ ...f, id: linkedId }), /真实路径属于私有配置/);
});
test('relay rejects forged result metadata and active MIME types', () => {
  const id = 'a'.repeat(64), meta = { id, name: 'test.html', size: 1, hash: 'b'.repeat(64),
    chunkBytes: CHUNK_BYTES, kind: 'image', mime: 'text/html' };
  assert.equal(validateResultInfo(meta, id).mime, 'application/octet-stream');
  assert.throws(() => validateResultInfo({ ...meta, name: '../escape' }, id), /名称/);
  assert.throws(() => validateResultInfo({ ...meta, size: 201 * 1024 * 1024 }, id), /无效/);
});
