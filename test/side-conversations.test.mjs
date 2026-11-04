import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopLogCandidates, sideParent, sideDetail, mergeSideConversations } from '../src/side-conversations.mjs';
import { Agent } from '../src/agent.mjs';
const root = '11111111-1111-4111-8111-111111111111', child = '22222222-2222-4222-8222-222222222222';
const state = () => ({ id: child, hostId: 'local', ephemeral: true, sideConversation: true, forkedFromId: root,
  sideConversationParentNavigationPath: `/local/${root}`, turns: [{turnId:'turn', status:'completed', items:[
    { id:'user', type:'userMessage', content:[{type:'text',text:'Test side conversation'}] },
    { id:'thought', type:'reasoning', text:'secret reasoning' },
    { id:'progress', type:'agentMessage', phase:'commentary', text:'working' },
    { id:'tool', type:'mcpToolCall', arguments:'private' },
    { id:'result', type:'agentMessage', phase:null, text:'Done' },
  ]}] });
test('runtime sidebar requires explicit parent and local verified snapshot; unrelated roots never inherit it', () => {
  const s = state(); assert.equal(sideParent(s), root);
  for (const patch of [{hostId:'other'},{ephemeral:false},{sideConversation:false},{forkedFromId:child},{sideConversationParentNavigationPath:'/local/other'}])
    assert.equal(sideParent({...s,...patch}), null);
  const snapshot = { threads:[{id:root,local:true,archived:false,childCount:0}],childThreads:[],sidebar:{} };
  const merged = mergeSideConversations(snapshot,[s]);
  assert.equal(merged.childThreads[0].id,child); assert.equal(merged.threads[0].childCount,1);
  assert.equal(mergeSideConversations({...snapshot,threads:[]},[s]).childThreads.length,0);
  assert.equal(mergeSideConversations({...snapshot,threads:[{id:root,local:true,archived:true}]},[s]).childThreads.length,0);
});
test('sidebar projection exposes only user input and final reply and keeps 15 messages', () => {
  const s = state(); assert.deepEqual(sideDetail(s).messages.map(m=>m.text), ['Test side conversation','Done']);
  s.turns = Array.from({length:20},(_,i)=>({...s.turns[0],turnId:String(i)}));
  assert.equal(sideDetail(s).messages.length,15);
  s.turns.at(-1).status='inProgress';
  assert.equal(sideDetail(s).messages.at(-1).role,'user');
});
test('desktop logs are candidates only and non-owner or malformed IDs are ignored', () => {
  const directory=mkdtempSync(join(tmpdir(),'codex-side-'));
  try {
    writeFileSync(join(directory,'codex-desktop-test.log'),`thread_stream_role_changed conversationId=${child} role=owner\nthread_stream_role_changed conversationId=${root} role=follower\n`, 'utf8');
    assert.deepEqual(desktopLogCandidates(directory),[child]);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
test('temporary sidebar never resumes a CLI writer or queues through a separate runtime', async () => {
  const s=state(); let sends=0;
  const agent={config:{controlsEnabled:true},inflight:new Set(),sideState:()=>s,
    desktop:{read:async()=>s,send:async()=>{sends++;return null;}},inputs:async()=>[],selection:async()=>({}),
    codex:{start:()=>{throw Error('must not create CLI owner');}}};
  await assert.rejects(Agent.prototype.handleSide.call(agent,'send',{threadId:child,text:'next'}),/补充本轮/);
  assert.equal(sends,1); assert.equal(agent.inflight.size,0);
  agent.desktop.read=async()=>null;
  await assert.rejects(Agent.prototype.handleSide.call(agent,'send',{threadId:child,text:'next'}),/关闭/);
  assert.equal(sends,1);
});
