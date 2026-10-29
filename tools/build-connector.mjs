import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/config.mjs';

const stage = resolve(ROOT, '.data', 'connector-package'), output = resolve(ROOT, 'public', 'downloads');
mkdirSync(stage, { recursive: true }); mkdirSync(output, { recursive: true });
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const manifest = { name: 'codex-phone-connector', version: '0.6.1', private: true, type: 'module', license: 'AGPL-3.0-only', engines: { node: '>=24.0.0' },
  scripts: { pair: 'node tools/pair.mjs', agent: 'node tools/remote-agent.mjs', 'install-connector': 'node tools/install-connector.mjs' },
  dependencies: { ws: lock.packages['node_modules/ws'].version } };
writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
writeFileSync(join(stage, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
  packages: { '': { name: manifest.name, version: manifest.version, license: manifest.license, dependencies: manifest.dependencies, engines: manifest.engines },
    'node_modules/ws': lock.packages['node_modules/ws'] } }, null, 2) + '\n', 'utf8');
const files = ['src/agent.mjs', 'src/desktop.mjs', 'src/config.mjs', 'src/codex.mjs', 'src/local-source.mjs', 'src/sidebar.mjs', 'src/transcript.mjs', 'src/activity.mjs',
  'src/attachment-common.mjs', 'src/agent-attachments.mjs',
  'tools/pair.mjs', 'tools/remote-agent.mjs', 'tools/connector-status.mjs', 'tools/install-connector.mjs',
  'start-remote-agent.ps1', 'start-remote-watch.ps1', 'install-remote-autostart.ps1',
  'connector-control.ps1', 'connector-task.ps1', 'run-remote-watch.vbs', 'install-connector-shortcuts.ps1',
  'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md',
  'vendor/agent-hub/LICENSE', 'vendor/agent-hub/PROVENANCE.json', 'vendor/agent-hub/package.json',
  'vendor/agent-hub/dist/desktop-ipc.mjs', 'vendor/agent-hub/dist/runtime-session.js', 'vendor/agent-hub/windows/desktop-pipe.ps1',
  'vendor/agent-hub/source/scripts/web-adapter-entry.mjs',
  'vendor/agent-hub/source/packages/codex-adapter/src/desktop-ipc.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/desktop-framing.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/desktop-live-window.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/desktop-platform.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/desktop-private-state-native.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/runtime.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/message-links.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/desktop-sidebar.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/desktop-history-identity.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/history-reader.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/generation-settings.ts',
  'vendor/agent-hub/source/packages/codex-adapter/src/windows-process.ts',
  'vendor/agent-hub/source/packages/codex-adapter/windows/desktop-pipe.ps1'];
for (const file of files) { const dest = join(stage, file); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(ROOT, file), dest); }
copyFileSync(join(ROOT, 'docs/CONNECT-ANOTHER-COMPUTER.md'), join(stage, 'README.md'));
copyFileSync(join(ROOT, 'docs/CONNECT-ANOTHER-COMPUTER.md'), join(output, 'CONNECT-ANOTHER-COMPUTER.md'));
if (process.platform !== 'win32') throw new Error('Package builder currently uses Windows Compress-Archive');
const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools/package-connector.ps1')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw new Error('Connector package failed');
