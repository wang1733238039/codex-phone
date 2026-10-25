import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSidebar, sidebarGroups } from '../src/sidebar.mjs';

const home = 'C:\\用户\\.codex', host = `local:${home}`;
function fixture() {
  return { home, projects: [{id:'native-a',name:'项目甲',position:1},{id:'native-b',name:'项目乙',position:0}],
    roots: [{project_id:'native-a',path:'C:\\甲',position:0},{project_id:'native-b',path:'C:\\乙',position:0}],
    sections: [{id:'pin',name:'Pinned'}],
    settings: { 'local-projects': { a:{id:'a',name:'项目甲',rootPaths:['C:\\甲']},b:{id:'b',name:'项目乙',rootPaths:['C:\\乙']} },
      'app-server-project-id-by-legacy-project-id-by-host': { [host]: {a:'native-a',b:'native-b'} },
      'app-server-projects-migration-by-host': { [host]: {threadAssignmentsMigrated:false} },
      'thread-project-assignments': { moved:{projectKind:'local',projectId:'a'},modern:{projectKind:'local',projectId:'a'} },
      'projectless-thread-ids':['loose'], 'pinned-thread-ids':['stale'],
      'electron-persisted-atom-state': {'sidebar-project-expanded-v1-codex:a':true} } };
}
test('native project IDs, manual moves, projectless chats and section pins survive desktop migration', () => {
  const data = fixture();
  const rows = [{id:'moved',cwd:'C:\\乙',project_id:null,thread_section_id:'pin',is_pinned:0},
    {id:'modern',cwd:'C:\\甲',project_id:'native-b'}, {id:'loose',cwd:'C:\\甲',project_id:null},
    {id:'inherited',cwd:'C:\\乙\\子目录'}, {id:'stale',thread_section_id:null,is_pinned:0}];
  const {threadFields: fields,sidebar} = resolveSidebar(rows,data);
  assert.equal(fields.get('moved').projectId,'a'); assert.equal(fields.get('moved').pinned,true);
  assert.equal(fields.get('modern').projectId,'b'); assert.equal(fields.get('loose').projectId,null);
  assert.equal(fields.get('inherited').projectId,'b'); assert.equal(fields.get('stale').pinned,false);
  assert.deepEqual(sidebar.projects.map(p=>p.id),['b','a']); assert.equal(sidebar.projects[1].expanded,true);
  data.settings['app-server-projects-migration-by-host'][host].threadAssignmentsMigrated=true;
  assert.equal(resolveSidebar(rows,data).threadFields.get('moved').projectId,null);
});
test('same names stay separate and shared workspace roots are not arbitrary assignments', () => {
  const data = fixture(); data.projects.forEach(p=>p.name='同名项目');
  data.roots.push({project_id:'native-b',path:'C:\\甲',position:1});
  let result=resolveSidebar([{id:'one',cwd:'C:\\甲'}],data);
  assert.equal(result.sidebar.projects.length,2); assert.equal(result.threadFields.get('one').projectId,'a');
  data.roots.at(-1).position=0; data.roots=data.roots.filter(r=>r.path!=='C:\\乙');
  assert.equal(resolveSidebar([{id:'one',cwd:'C:\\甲'}],data).threadFields.get('one').projectId,null);
});
test('older schema works without settings, and explicit modern null membership stays projectless', () => {
  assert.equal(resolveSidebar([{id:'old',cwd:'C:\\甲'}]).threadFields.get('old').projectId,null);
  const result=resolveSidebar([{id:'old',cwd:'C:\\甲'}],{settings:{'local-projects':{a:{id:'a',name:'中文项目',rootPaths:['C:\\甲']}},'pinned-thread-ids':['old']}});
  assert.equal(result.threadFields.get('old').projectId,'a'); assert.equal(result.threadFields.get('old').pinned,true);
  const data=fixture(); data.settings={};
  assert.equal(resolveSidebar([{id:'new',project_id:null,cwd:'C:\\甲'}],data).threadFields.get('new').projectId,null);
});
test('groups preserve manual order, avoid duplicate pinned rows and keep archived/search results grouped', () => {
  const sidebar={projects:[{id:'a',name:'甲'},{id:'b',name:'乙'}],preferences:{sorting:{chats:'manual',pinned:'manual'}}};
  const threads=[{id:'pin',pinned:true,projectId:'a'}, {id:'new',projectId:'a',projectPosition:1,updatedAt:20}, {id:'old',projectId:'a',projectPosition:0,updatedAt:1}, {id:'loose'}];
  let groups=sidebarGroups(threads,sidebar);
  assert.deepEqual(groups.map(g=>g.id),['pinned','project:a','project:b','unassigned']);
  assert.deepEqual(groups[1].threadIds,['old','new']);
  assert.equal(groups.flatMap(g=>g.threadIds).length,4);
  assert.equal(sidebarGroups(threads,sidebar,{searching:true}).some(g=>g.id==='project:b'),false);
  groups=sidebarGroups(threads,sidebar,{archived:true}); assert.equal(groups.some(g=>g.id==='pinned'),false);
  assert.ok(groups.find(g=>g.id==='project:a').threadIds.includes('pin'));
});
