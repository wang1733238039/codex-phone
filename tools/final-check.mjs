import { writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.mjs';

function luminance(hex) { const a = hex.match(/[a-f\d]{2}/gi).map(h => parseInt(h, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return .2126 * a[0] + .7152 * a[1] + .0722 * a[2]; }
const pairs = [['ink', '18263c', 'f4f6fb'], ['muted', '53647b', 'f4f6fb'], ['button', 'fbfcff', '254edb'], ['offline', '795020', 'fff1dd'], ['online', '186951', 'f4f6fb']];
const contrast = pairs.map(([name, fg, bg]) => { const a = luminance(fg), b = luminance(bg); return { name, ratio: Math.round((Math.max(a, b) + .05) / (Math.min(a, b) + .05) * 100) / 100 }; });
if (contrast.some(p => p.ratio < 4.5)) throw new Error('Contrast check failed');
const assets = ['public/index.html', 'public/styles.css', 'public/conversation.css', 'public/app.js', 'public/inbox.js', 'public/attachments.js', 'public/device-icons.svg', 'node_modules/marked/lib/marked.umd.js', 'node_modules/dompurify/dist/purify.min.js'];
const report = { contrast, bytesBeforeCompression: assets.reduce((n, p) => n + statSync(resolve(ROOT, p)).size, 0) };
writeFileSync(resolve(ROOT, 'artifacts/quality-report.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report));
