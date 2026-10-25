import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { LocalSource } from '../src/local-source.mjs';
import { loadConfig, ROOT } from '../src/config.mjs';
import { compareThreads, sidebarGroups } from '../src/sidebar.mjs';

const source = new LocalSource(loadConfig('agent').codexHome);
try {
  const { threads, sidebar } = source.snapshot();
  const active = threads.filter(t => !t.archived).sort((a,b) => compareThreads(a,b,sidebar));
  const reference = JSON.parse(readFileSync(join(ROOT, 'artifacts/sidebar-native-reference.json'), 'utf8'));
  const mismatches = [...reference.threads.pinnedThreads, ...reference.threads.threads].flatMap(t => {
    const actual = threads.find(x => x.id === t.id);
    return actual && actual.projectId !== t.projectId ? [{ id:t.id, expected:t.projectId, actual:actual.projectId }] : [];
  });
  assert.deepEqual(mismatches, []);
  assert.deepEqual(active.filter(t => t.pinned).map(t => t.id), reference.threads.pinnedThreads.map(t => t.id));
  assert.deepEqual(sidebar.projects.map(p => ({id:p.id,name:p.name})), reference.projects);
  const groups = sidebarGroups(active, sidebar);
  assert.equal(new Set(groups.flatMap(g => g.threadIds)).size, active.length);
  assert.equal(groups.flatMap(g => g.threadIds).length, active.length);
  const report = { passed: true, projectCount: sidebar.projects.length, comparedNativeThreads: reference.threads.pinnedThreads.length + reference.threads.threads.length,
    pinnedCount: active.filter(t => t.pinned).length, activeCount: active.length, groups: groups.map(g => ({name:g.name,count:g.threadIds.length})) };
  writeFileSync(join(ROOT, 'artifacts/sidebar-report.json'), JSON.stringify(report,null,2), 'utf8');
  console.log(JSON.stringify(report));
} finally { source.close(); }
