// Shared, dependency-free Markdown destination extraction. No path grants come
// from user messages, code examples, tool output, HTML attributes or URL input.
export function localResultReference(reference) {
  if (typeof reference !== 'string' || reference.length > 4096) return null;
  let value = reference.trim();
  try { value = decodeURIComponent(value); } catch {}
  value = value.replace(/\\([() ])/g, '$1');
  if (/[\x00-\x1f\x7f]/.test(value) || /^(?:https?:|data:|javascript:|blob:|mailto:|tel:|#|\/\/|\\\\)/i.test(value)) return null;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
    } catch { return null; }
  } else if (/^sandbox:/i.test(value)) value = value.slice(8);
  else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null;
  value = value.replace(/#(?:L?\d+(?:-L?\d+)?)?$/, '').replace(/:\d+(?::\d+)?$/, '');
  if (!value || !/\.[a-z\d]{1,12}$/i.test(value)) return null;
  return value;
}

export function resultReferences(messages = []) {
  const results = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant' || message.phase !== 'final_answer') continue;
    const text = String(message.text || '').slice(0, 256000)
      .replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*|$)/g, '')
      .replace(/`+[^`\n]*`+/g, '');
    const add = reference => {
      if (results.length >= 100) return;
      if (localResultReference(reference) && !results.some(r => r.index === index && r.reference === reference))
        results.push({ index, reference });
    };
    const pattern = /!?\[[^\]\n]{0,500}\]\(/g;
    let match;
    while ((match = pattern.exec(text)) && results.length < 100) {
      let cursor = pattern.lastIndex, reference = '', depth = 0;
      while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++;
      if (text[cursor] === '<') {
        const end = text.indexOf('>', cursor + 1);
        if (end < 0 || end - cursor > 4096) continue;
        reference = text.slice(cursor + 1, end);
        if (!/^\s*(?:(?:"[^"\n]*"|'[^'\n]*')\s*)?\)/.test(text.slice(end + 1))) continue;
      } else {
        const start = cursor;
        for (; cursor < Math.min(text.length, start + 4096); cursor++) {
          if (text[cursor] === '\\') { cursor++; continue; }
          if (text[cursor] === '(') depth++;
          if (text[cursor] === ')' && depth-- === 0) break;
          if (/\s/.test(text[cursor]) && depth === 0) break;
        }
        reference = text.slice(start, cursor);
        if (!/^\s*(?:(?:"[^"\n]*"|'[^'\n]*')\s*)?\)/.test(text.slice(cursor))) continue;
      }
      add(reference);
    }
    // Reference-style Markdown links are included only when the label is used.
    for (const definition of text.matchAll(/^\s{0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|\S+)/gm)) {
      const label = definition[1], marker = `[${label}]`;
      if (!text.slice(0, definition.index).includes(marker) && !text.slice(definition.index + definition[0].length).includes(marker)) continue;
      add(definition[2].replace(/^<|>$/g, ''));
    }
  }
  return results;
}
