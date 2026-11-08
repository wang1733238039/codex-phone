/* SheetJS runs off the UI thread, on demand, with bounded output. */
importScripts('/vendor/xlsx.js?v=0.20.3');
function zipBudget(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('表格压缩结构无效，请下载原文件查看');
  const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true);
  if (count > 4096 || start > bytes.length) throw new Error('此表格结构过大，请下载后查看');
  let offset = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('表格目录无效');
    const size = view.getUint32(offset + 24, true); expanded += size;
    if (size > 32 * 1048576 || expanded > 64 * 1048576) throw new Error('此表格展开后过大，请下载后查看');
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}
self.onmessage = event => {
  try {
    const buffer = event.data;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > 8 * 1048576) throw new Error('表格超过 8 MB，请下载后查看');
    zipBudget(buffer);
    const workbook = XLSX.read(buffer, { type: 'array', sheetRows: 201, sheets: Array.from({ length: 10 }, (_, i) => i),
      cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, codepage: 65001, dense: true });
    let remaining = 2 * 1048576;
    const sheets = workbook.SheetNames.slice(0, 10).filter(name => workbook.Sheets[name]).map(name => {
      const sheet = workbook.Sheets[name], range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
      const full = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1:A1');
      const rows = [];
      for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 199); r++) {
        const row = [];
        for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + 29); c++) {
          const cell = sheet['!data']?.[r]?.[c] || sheet[XLSX.utils.encode_cell({ r, c })];
          const text = cell ? String(XLSX.utils.format_cell(cell)).slice(0, Math.max(0, Math.min(2000, remaining))) : '';
          remaining -= text.length; row.push(text);
        }
        rows.push(row);
      }
      return { name, rows, totalRows: full.e.r - full.s.r + 1, totalColumns: full.e.c - full.s.c + 1,
        truncated: full.e.r - full.s.r >= 200 || full.e.c - full.s.c >= 30 || remaining <= 0 };
    });
    if (!sheets.length) throw new Error('没有可预览的工作表，请下载原文件查看');
    self.postMessage({ sheets, truncated: workbook.SheetNames.length > 10 });
  } catch (error) { self.postMessage({ error: error.message || '表格解析失败，请下载后查看' }); }
};
