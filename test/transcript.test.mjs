import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcript, TRANSCRIPT_VERSION, userText } from '../src/transcript.mjs';

const event = (type, rest = {}) => ({ type: 'event_msg', payload: { type, ...rest }, timestamp: '2026-10-23T03:00:00Z' });
const message = (role, text, phase, id) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }], phase, id } });
const completed = (type, text, phase, id) => event('item_completed', { item: { type, id, phase, content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text }] } });
function project(...items) { const transcript = new Transcript(); for (const item of items) transcript.push(item); return transcript.finish(); }
const texts = detail => detail.messages.map(m => m.text);

test('desktop completed items exclude instructions, compaction summaries, progress, thinking and tools', () => {
  const detail = project(
    event('task_started'),
    message('user', '<environment_context>internal paths</environment_context>'),
    message('user', '我的问题'), completed('UserMessage', '我的问题', null, 'user-1'),
    completed('AgentMessage', '正在调查', 'commentary', 'progress-1'), message('assistant', '正在调查', 'commentary', 'progress-1'),
    event('item_completed', { item: { type: 'Reasoning', summary_text: ['private reasoning'], raw_content: ['secret'] } }),
    { type: 'response_item', payload: { type: 'function_call', arguments: 'private arguments' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'private tool output' } },
    message('assistant', 'injected compaction summary', 'final_answer', 'compaction-1'),
    completed('AgentMessage', '结果一，包含工具使用说明', 'final_answer', 'final-1'),
    message('assistant', '结果一，包含内部元数据', 'final_answer', 'final-1'),
    completed('AgentMessage', '结果二', 'final_answer', 'final-2'),
    completed('AgentMessage', '结果二', 'final_answer', 'final-2'),
    event('task_complete', { last_agent_message: '结果二' })
  );
  assert.deepEqual(texts(detail), ['我的问题', '结果一，包含工具使用说明', '结果二']);
  assert.equal(detail.running, false); assert.equal(detail.transcriptVersion, TRANSCRIPT_VERSION);
  assert.ok(detail.messages.filter(m => m.role === 'assistant').every(m => m.phase === 'final_answer'));
});

test('response-only logs retain multiple actual inputs and finals and remove known context envelopes', () => {
  const detail = project(
    event('task_started'),
    message('user', '# AGENTS.md instructions\n<INSTRUCTIONS>injected rules</INSTRUCTIONS>\n<environment_context>paths</environment_context>'),
    message('developer', 'private developer instructions'),
    message('user', '<in-app-browser-context source="ambient-ui-state">private URL</in-app-browser-context>\n\n## My request:\n我的输入'),
    message('assistant', '正在查找', 'commentary'), message('assistant', '未分类的中间消息'),
    message('assistant', '第一次答复', 'final_answer', 'a-1'),
    message('user', '继续'), message('user', '继续'),
    message('assistant', '第二次答复', 'final_answer', 'a-2'),
    event('task_complete', { last_agent_message: '第二次答复' })
  );
  assert.deepEqual(texts(detail), ['我的输入', '第一次答复', '继续', '继续', '第二次答复']);
  assert.equal(userText('请解释 <environment_context> 的含义'), '请解释 <environment_context> 的含义');
  assert.deepEqual(texts(project(event('task_started'), message('assistant', '最终回复（包含附件元数据）', 'final_answer'),
    event('task_complete', { last_agent_message: '最终回复' }))), ['最终回复（包含附件元数据）']);
});

test('phase-less legacy replies need completion evidence, running/aborted turns never reveal progress', () => {
  const detail = project(
    event('task_started'), event('user_message', { message: '旧版问题' }),
    event('agent_message', { message: '中间进度' }), event('agent_message', { message: '旧版最终回复' }),
    event('task_complete', { last_agent_message: '旧版最终回复' }),
    event('task_started'), message('user', '第二个问题'), message('assistant', '准备调用工具'),
    event('turn_aborted'),
    event('task_started'), message('user', '第三个问题'), completed('AgentMessage', '运行中的进度', 'commentary')
  );
  assert.deepEqual(texts(detail), ['旧版问题', '旧版最终回复', '第二个问题', '第三个问题']);
  assert.equal(detail.running, true);
  assert.deepEqual(texts(project(event('task_started'), event('task_complete', { last_agent_message: '仅完成事件中的回复' }))), ['仅完成事件中的回复']);
  assert.deepEqual(texts(project(event('task_started'), message('assistant', '进度', 'commentary'), event('task_complete', { last_agent_message: '进度' }))), []);
});

test('mixed log versions choose visible events per turn without suppressing earlier raw history', () => {
  const detail = project(
    event('task_started'), message('user', '旧输入'), message('assistant', '旧输出', 'final_answer'), event('task_complete'),
    event('task_started'), message('user', 'new raw copy'), completed('UserMessage', '新输入', null, 'new-user'),
    completed('AgentMessage', '新输出', 'final_answer', 'new-final'), message('assistant', 'new raw copy', 'final_answer', 'new-final'), event('task_complete')
  );
  assert.deepEqual(texts(detail), ['旧输入', '旧输出', '新输入', '新输出']);
});
