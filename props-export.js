// ===========================================================================
// props-export.js — Excel, PDF and CSV exports for the Properties section.
//
// The browser sends the tab exactly as it is on screen: a title, the period,
// the cards, and each table as a header plus rows of raw values with a format
// per cell. This file only lays that out. It reads nothing from the database,
// so an export can never carry more than the screen it came from.
//
//   Excel  one sheet per table, totals bold on a band, money/percent/ratio
//          number formats, header row and first column frozen; an About sheet
//          says what it is, for whom and when. Never a title row above the
//          header: that breaks every pivot the reader is about to build.
//   PDF    report layout: header, cards, then each table, repeating its
//          header row across pages.
//   CSV    one file per table, zipped.
//
// File name: "<Property> - <Tab> - <Period>.<ext>", or "<View name>.<ext>".
// ===========================================================================
'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');

const MAX_TABLES = 20, MAX_ROWS = 5000, MAX_COLS = 40;
const FMTS = ['money', 'money2', 'pct', 'ratio', 'count', 'text', 'number'];
const s = (v, n) => String(v === null || v === undefined ? '' : v).slice(0, n || 300);

function clean(body) {
  const b = body && typeof body === 'object' ? body : {};
  const tables = (Array.isArray(b.tables) ? b.tables : []).slice(0, MAX_TABLES).map(t => ({
    title: s(t && t.title, 120) || 'Table',
    heads: (Array.isArray(t && t.heads) ? t.heads : []).slice(0, MAX_COLS).map(h => s(h, 80)),
    rows: (Array.isArray(t && t.rows) ? t.rows : []).slice(0, MAX_ROWS).map(r => ({
      label: s(r && r.label, 200),
      kind: ['total', 'key', 'group', ''].indexOf(r && r.kind) >= 0 ? r.kind : '',
      cells: (Array.isArray(r && r.cells) ? r.cells : []).slice(0, MAX_COLS - 1).map(c => {
        const fmt = FMTS.indexOf(c && c.f) >= 0 ? c.f : 'text';
        const v = c ? c.v : null;
        if (fmt === 'text') return { f: 'text', v: v === null || v === undefined ? '' : s(v, 200) };
        const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
        return { f: fmt, v: n };
      }),
    })),
  }));
  const cards = (Array.isArray(b.cards) ? b.cards : []).slice(0, 24).map(c => ({ label: s(c && c.label, 80), value: s(c && c.value, 60), sub: s(c && c.sub, 160) }));
  return {
    base: (s(b.filename, 180) || 'Export').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim(),
    title: s(b.title, 160), subtitle: s(b.subtitle, 240), cards, tables,
  };
}

function display(c) {
  if (c.f === 'text') return c.v;
  const v = c.v;
  if (v === null) return '–';
  const abs = Math.abs(v);
  let t;
  if (c.f === 'pct') return (v * 100).toFixed(1) + '%';
  if (c.f === 'ratio') return v.toFixed(2);
  if (c.f === 'count') return Math.round(v).toLocaleString('en-US');
  if (c.f === 'money2' || c.f === 'number') t = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else t = '$' + abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return v < 0 ? '(' + t + ')' : t;
}

const XL_FMT = { money: '$#,##0;($#,##0)', money2: '#,##0.00;(#,##0.00)', number: '#,##0.00;(#,##0.00)', pct: '0.0%', ratio: '0.00', count: '#,##0' };

async function xlsx(x, who) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LeavenWealth portal';
  const used = new Set();
  const sheetName = t => {
    let n = t.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet';
    let k = n, i = 2;
    while (used.has(k.toLowerCase())) k = n.slice(0, 25) + ' ' + i++;
    used.add(k.toLowerCase());
    return k;
  };
  if (x.cards.length) {
    const ws = wb.addWorksheet(sheetName('Cards'));
    ws.addRow(['Figure', 'Value', 'Basis']).font = { bold: true };
    x.cards.forEach(c => ws.addRow([c.label, c.value, c.sub]));
    ws.columns = [{ width: 34 }, { width: 18 }, { width: 60 }];
  }
  for (const t of x.tables) {
    const ws = wb.addWorksheet(sheetName(t.title), { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
    const head = ws.addRow(t.heads);
    head.font = { bold: true };
    head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEEEA' } }; c.alignment = { horizontal: 'center' }; });
    for (const r of t.rows) {
      const row = ws.addRow([r.label].concat(r.cells.map(c => (c.f === 'text' ? c.v : c.v))));
      r.cells.forEach((c, i) => { const cell = row.getCell(i + 2); if (XL_FMT[c.f]) cell.numFmt = XL_FMT[c.f]; });
      if (r.kind === 'group') { row.font = { bold: true }; }
      if (r.kind === 'total' || r.kind === 'key') {
        row.font = { bold: true };
        if (r.kind === 'total') row.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF9F7' } }; c.border = { top: { style: 'thin' } }; });
      }
    }
    ws.getColumn(1).width = Math.min(48, Math.max(18, ...t.rows.map(r => r.label.length + 2), (t.heads[0] || '').length + 2));
    for (let i = 2; i <= t.heads.length; i++) ws.getColumn(i).width = 14;
  }
  const about = wb.addWorksheet(sheetName('About'));
  [['Report', x.title], ['Period', x.subtitle], ['Exported at', new Date().toISOString()], ['Exported by', (who && who.email) || ''],
   ['Basis', 'Cash basis, from the property management systems via the reporting views. "–" means not available.']]
    .forEach(r => about.addRow(r));
  about.getColumn(1).width = 16; about.getColumn(2).width = 90;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pdf(x) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 36, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 72, X0 = 36;
    const INK = '#1A1A18', MUTED = '#5D5B56', RULE = '#E3E1DC', BAND = '#FAF9F7', BAD = '#B42318';

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(x.title || x.base, X0, 36, { width: W });
    if (x.subtitle) doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(x.subtitle, { width: W });
    doc.fontSize(8).fillColor(MUTED).text('Exported ' + new Date().toISOString().slice(0, 10) + '. Cash basis. "–" means not available.', { width: W });
    doc.moveDown(0.6);

    if (x.cards.length) {
      const per = Math.min(4, x.cards.length), cw = W / per, ch = 46;
      let y = doc.y;
      x.cards.forEach((c, i) => {
        const col = i % per;
        if (col === 0 && i > 0) y += ch + 6;
        if (y + ch > doc.page.height - 36) { doc.addPage(); y = 36; }
        const cx = X0 + col * cw;
        doc.rect(cx, y, cw - 6, ch).strokeColor(RULE).lineWidth(0.6).stroke();
        doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(c.label, cx + 6, y + 5, { width: cw - 18, height: 10, ellipsis: true });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(c.value, cx + 6, y + 16, { width: cw - 18, height: 14, ellipsis: true });
        doc.fillColor(MUTED).font('Helvetica').fontSize(6.5).text(c.sub, cx + 6, y + 33, { width: cw - 18, height: 9, ellipsis: true });
      });
      doc.y = y + ch + 14;
    }

    for (const t of x.tables) {
      const ncol = Math.max(1, t.heads.length);
      const fs = ncol > 12 ? 6.5 : ncol > 8 ? 7.5 : 8.5;
      const first = Math.min(190, Math.max(110, W * (ncol > 10 ? 0.18 : 0.28)));
      const rest = ncol > 1 ? (W - first) / (ncol - 1) : 0;
      const rh = fs + 6;
      const colX = i => (i === 0 ? X0 : X0 + first + (i - 1) * rest);
      const colW = i => (i === 0 ? first : rest);
      const header = y => {
        doc.rect(X0, y, W, rh).fill('#EFEEEA');
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(fs);
        t.heads.forEach((h, i) => doc.text(h, colX(i) + 3, y + 3, { width: colW(i) - 6, height: rh, align: i ? 'right' : 'left', ellipsis: true, lineBreak: false }));
        return y + rh;
      };
      if (doc.y + 40 > doc.page.height - 36) doc.addPage();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(t.title, X0, doc.y, { width: W });
      let y = header(doc.y + 4);
      for (const r of t.rows) {
        if (y + rh > doc.page.height - 36) { doc.addPage(); y = header(36); }
        if (r.kind === 'total' || r.kind === 'group') doc.rect(X0, y, W, rh).fill(BAND);
        doc.moveTo(X0, y + rh).lineTo(X0 + W, y + rh).strokeColor(RULE).lineWidth(0.4).stroke();
        const bold = r.kind === 'total' || r.kind === 'key' || r.kind === 'group';
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor(INK);
        doc.text(r.label, colX(0) + 3, y + 3, { width: colW(0) - 6, height: rh, ellipsis: true, lineBreak: false });
        r.cells.forEach((c, i) => {
          const txt = display(c);
          doc.fillColor(c.f !== 'text' && c.v !== null && c.v < 0 ? BAD : txt === '–' ? MUTED : INK)
             .text(txt, colX(i + 1) + 3, y + 3, { width: colW(i + 1) - 6, height: rh, align: c.f === 'text' ? 'left' : 'right', ellipsis: true, lineBreak: false });
        });
        y += rh;
      }
      doc.y = y + 16;
      doc.x = X0;
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;   /* the footer sits below the margin; without this pdfkit adds a blank page */
      doc.fillColor(MUTED).font('Helvetica').fontSize(7).text((x.title || x.base) + '   ' + (i + 1) + ' of ' + range.count,
        X0, doc.page.height - 26, { width: W, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

/* A text cell starting with = + - @ would run as a formula when the file is
   opened in a spreadsheet; a leading apostrophe makes it plain text. Numbers,
   negatives included, are left alone. */
function csvCell(v) {
  let t = v === null || v === undefined ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function zipCsv(x) {
  return new Promise((resolve, reject) => {
    const arc = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    arc.on('data', c => chunks.push(c)); arc.on('end', () => resolve(Buffer.concat(chunks))); arc.on('error', reject);
    const used = new Set();
    const tables = x.cards.length
      ? [{ title: 'Cards', heads: ['Figure', 'Value', 'Basis'], rows: x.cards.map(c => ({ label: c.label, cells: [{ f: 'text', v: c.value }, { f: 'text', v: c.sub }] })) }].concat(x.tables)
      : x.tables;
    for (const t of tables) {
      const lines = [t.heads.map(csvCell).join(',')].concat(t.rows.map(r =>
        [csvCell(r.label)].concat(r.cells.map(c => csvCell(c.f === 'text' ? c.v : c.v === null ? '' : c.v))).join(',')));
      let n = (x.base + ' - ' + t.title).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 150), k = n, i = 2;
      while (used.has(k)) k = n + ' ' + i++;
      used.add(k);
      arc.append('﻿' + lines.join('\r\n') + '\r\n', { name: k + '.csv' });
    }
    arc.finalize();
  });
}

async function buildExport(fmt, body, who) {
  const x = clean(body);
  if (fmt === 'xlsx') return { filename: x.base + '.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await xlsx(x, who) };
  if (fmt === 'pdf') return { filename: x.base + '.pdf', type: 'application/pdf', buffer: await pdf(x) };
  return { filename: x.base + '.zip', type: 'application/zip', buffer: await zipCsv(x) };
}

module.exports = { buildExport, _internal: { clean, display, csvCell } };
