import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/config.mjs';

const config = join(ROOT, '.data', 'agent.remote.json');
if (!existsSync(config)) throw new Error('Run node tools/pair.mjs first');
if (process.platform === 'win32') {
  const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'install-remote-autostart.ps1')],
    { stdio: 'inherit', windowsHide: true, cwd: ROOT });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows connector installation failed (${result.status ?? result.signal})`);
  const shortcuts = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'install-connector-shortcuts.ps1')],
    { stdio: 'inherit', windowsHide: true, cwd: ROOT });
  if (shortcuts.error) throw shortcuts.error;
  if (shortcuts.status !== 0) throw new Error(`Windows shortcut installation failed (${shortcuts.status ?? shortcuts.signal})`);
} else if (process.platform === 'darwin') {
  const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const dir = join(homedir(), 'Library', 'LaunchAgents'); mkdirSync(dir, { recursive: true });
  const label = 'vip.qieziai.codex-phone', file = join(dir, label + '.plist'), domain = `gui/${process.getuid()}`;
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(escape(ROOT))) throw new Error('Another connector installation already owns this LaunchAgent. Existing installation preserved.');
  const args = [process.execPath, join(ROOT, 'tools', 'remote-agent.mjs')].map(s => `<string>${escape(s)}</string>`).join('');
  const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args}</array><key>WorkingDirectory</key><string>${escape(ROOT)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>20</integer><key>StandardOutPath</key><string>${escape(join(ROOT, '.data', 'remote-agent.stdout.log'))}</string><key>StandardErrorPath</key><string>${escape(join(ROOT, '.data', 'remote-agent.stderr.log'))}</string></dict></plist>`;
  writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 }); chmodSync(file, 0o600);
  spawnSync('/bin/launchctl', ['bootout', domain, file], { stdio: 'ignore' });
  const result = spawnSync('/bin/launchctl', ['bootstrap', domain, file], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('LaunchAgent registration failed');
  console.log('Connector installed for current-user login startup.');
} else {
  throw new Error('Automatic startup supports Windows and macOS. Run node tools/remote-agent.mjs manually on other systems.');
}
