// ===========================================================================
// reports-export.js — a Reports document (reports-core buildDoc) as a file.
//
//   Excel  one sheet per report (Income report, Rent roll, Optimized NOI),
//          each property a titled block on it, plus an About sheet.
//   PDF    the preview's layout: report header, then each property with its
//          sections, cards and tables, table headers repeated across pages.
//   CSV    one file per property per report, zipped.
//
// Reads nothing from the database: the document was already built under the
// right person's access, so a file can never hold more than the preview.
// ===========================================================================
'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const { display, csvCell } = require('./props-export')._internal;

const XL_FMT = { money: '$#,##0;($#,##0)', money2: '#,##0.00;(#,##0.00)', pct: '0.0%', ratio: '0.00', count: '#,##0' };
const SHEETS = { income: 'Income report', rr: 'Rent roll', opt: 'Optimized NOI' };
const safeName = s => String(s || 'Report').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Report';

async function xlsx(doc) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LeavenWealth dashboard';
  const about = wb.addWorksheet('About');
  [['Report', doc.name], ['Includes', doc.includes], ['Period', doc.period], ['Data through', doc.dataThrough || ''],
   ['', doc.generated], ['Basis', 'Cash basis, from the property management systems. Blank means not available.']]
    .forEach(r => about.addRow(r));
  about.getColumn(1).width = 16; about.getColumn(2).width = 90; about.getRow(1).font = { bold: true };

  for (const kind of Object.keys(SHEETS)) {
    const blocks = doc.docs.map(d => ({ d, s: d.sections.find(x => x.kind === kind) })).filter(x => x.s);
    if (!blocks.length) continue;
    const ws = wb.addWorksheet(SHEETS[kind]);
    let widest = 18, cols = 1;
    for (const { d, s } of blocks) {
      const title = ws.addRow([d.name + ' - ' + s.title]); title.font = { bold: true, size: 12 };
      ws.addRow([s.sub]).font = { italic: true, color: { argb: 'FF5D5B56' } };
      (s.cards || []).forEach(c => ws.addRow([c.k, c.v]));
      if (s.note) ws.addRow([s.note]).font = { italic: true, color: { argb: 'FF5D5B56' } };
      if (s.table) {
        const t = s.table;
        const head = ws.addRow([''].concat(t.heads, t.hasTotal ? ['Total'] : []));
        head.font = { bold: true };
        head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEEEA' } }; });
        cols = Math.max(cols, t.heads.length + 2);
        for (const r of t.rows) {
          const cells = r.cells.concat(t.hasTotal ? [r.tot || { f: 'text', v: '' }] : []);
          const xr = ws.addRow([(r.indent ? '   ' : '') + r.label].concat(cells.map(c => c.v)));
          cells.forEach((c, i) => { if (XL_FMT[c.f]) xr.getCell(i + 2).numFmt = XL_FMT[c.f]; });
          if (r.kind) xr.font = { bold: true };
          if (r.kind === 'total') xr.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF9F7' } }; c.border = { top: { style: 'thin' } }; });
          widest = Math.max(widest, r.label.length + 4);
        }
      }
      ws.addRow([]);
    }
    ws.getColumn(1).width = Math.min(50, widest);
    for (let i = 2; i <= cols; i++) ws.getColumn(i).width = 14;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pdf(doc) {
  return new Promise((resolve, reject) => {
    const pd = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 36, bufferPages: true });
    const chunks = [];
    pd.on('data', c => chunks.push(c)); pd.on('end', () => resolve(Buffer.concat(chunks))); pd.on('error', reject);
    const W = pd.page.width - 72, X0 = 36, BOTTOM = () => pd.page.height - 40;
    const INK = '#1A1A18', MUTED = '#5D5B56', RULE = '#E3E1DC', BAND = '#FAF9F7', BAD = '#B42318';
    const room = h => { if (pd.y + h > BOTTOM()) { pd.addPage(); pd.y = 36; } };

    /* header, as the preview: company, report name, generated line, rule */
    pd.fillColor(MUTED).font('Helvetica').fontSize(9).text('LeavenWealth', X0, 36);
    pd.fillColor(INK).font('Helvetica-Bold').fontSize(17).text(doc.name, X0, 49, { width: W * 0.68 });
    pd.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(doc.generated, X0 + W * 0.68, 40, { width: W * 0.32, align: 'right' });
    pd.y = Math.max(pd.y, 72) + 6;
    pd.moveTo(X0, pd.y).lineTo(X0 + W, pd.y).strokeColor(INK).lineWidth(1.5).stroke();
    pd.y += 6;
    if (doc.omitted) pd.fillColor(MUTED).font('Helvetica').fontSize(8).text(doc.omitted + ' selected ' + (doc.omitted === 1 ? 'property is' : 'properties are') + ' not included: no access or no report data.', X0, pd.y, { width: W });

    for (const d of doc.docs) {
      room(60);
      pd.y += 10;
      pd.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(d.name, X0, pd.y, { width: W });
      pd.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(d.sub, X0, pd.y, { width: W });
      for (const s of d.sections) {
        room(40);
        pd.y += 8;
        const ty = pd.y;
        pd.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(s.title, X0, ty, { continued: false });
        pd.fillColor(MUTED).font('Helvetica').fontSize(8).text(s.sub || '', X0 + pd.widthOfString(s.title, { font: 'Helvetica-Bold', size: 10.5 }) + 10, ty + 2, { width: W / 2 });
        pd.y = ty + 15;
        if (s.cards && s.cards.length) {
          const cw = W / s.cards.length, ch = 30; room(ch + 4);
          const y = pd.y;
          pd.rect(X0, y, W, ch).strokeColor(RULE).lineWidth(0.6).stroke();
          s.cards.forEach((c, i) => {
            const cx = X0 + i * cw;
            if (i) pd.moveTo(cx, y).lineTo(cx, y + ch).strokeColor(RULE).stroke();
            pd.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(c.k, cx + 6, y + 4, { width: cw - 12, lineBreak: false, ellipsis: true });
            pd.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(c.v, cx + 6, y + 15, { width: cw - 12, lineBreak: false, ellipsis: true });
          });
          pd.y = y + ch + 6;
        }
        if (s.note) { pd.fillColor(MUTED).font('Helvetica').fontSize(8).text(s.note, X0, pd.y, { width: W }); pd.y += 2; }
        if (!s.table) continue;
        const t = s.table;
        const heads = [''].concat(t.heads, t.hasTotal ? ['Total'] : []);
        const ncol = heads.length;
        const fs = ncol > 13 ? 6.3 : ncol > 9 ? 7.2 : 8.2;
        const first = Math.min(200, Math.max(120, W * (ncol > 10 ? 0.2 : 0.3)));
        const rest = ncol > 1 ? (W - first) / (ncol - 1) : 0;
        const rh = fs + 6;
        const colX = i => (i === 0 ? X0 : X0 + first + (i - 1) * rest);
        const colW = i => (i === 0 ? first : rest);
        const header = y => {
          pd.rect(X0, y, W, rh).fill('#EFEEEA');
          pd.fillColor(MUTED).font('Helvetica-Bold').fontSize(fs);
          heads.forEach((h, i) => pd.text(h, colX(i) + 3, y + 3, { width: colW(i) - 6, align: i ? 'right' : 'left', lineBreak: false, ellipsis: true }));
          return y + rh;
        };
        room(rh * 3);
        let y = header(pd.y + 2);
        for (const r of t.rows) {
          if (y + rh > BOTTOM()) { pd.addPage(); y = header(36); }
          if (r.kind === 'total' || r.kind === 'group') pd.rect(X0, y, W, rh).fill(BAND);
          pd.moveTo(X0, y + rh).lineTo(X0 + W, y + rh).strokeColor(RULE).lineWidth(0.4).stroke();
          pd.font(r.kind ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor(r.indent ? MUTED : INK);
          pd.text(r.label, colX(0) + 3 + (r.indent ? 10 : 0), y + 3, { width: colW(0) - 16, lineBreak: false, ellipsis: true });
          const cells = r.cells.concat(t.hasTotal ? [r.tot || { f: 'text', v: '' }] : []);
          cells.forEach((c, i) => {
            const txt = c.f === 'text' ? String(c.v || '') : display(c);
            pd.fillColor(c.f !== 'text' && c.v !== null && c.v < 0 ? BAD : txt === '–' ? MUTED : INK)
              .text(txt, colX(i + 1) + 3, y + 3, { width: colW(i + 1) - 6, align: c.f === 'text' ? 'left' : 'right', lineBreak: false, ellipsis: true });
          });
          y += rh;
        }
        pd.y = y + 6; pd.x = X0;
      }
    }
    const range = pd.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pd.switchToPage(i);
      pd.page.margins.bottom = 0;   /* the footer sits below the margin; without this pdfkit adds a blank page */
      pd.fillColor(MUTED).font('Helvetica').fontSize(7).text(doc.name + '   ' + (i + 1) + ' of ' + range.count, X0, pd.page.height - 26, { width: W, align: 'right', lineBreak: false });
    }
    pd.end();
  });
}

function zipCsv(doc) {
  return new Promise((resolve, reject) => {
    const arc = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    arc.on('data', c => chunks.push(c)); arc.on('end', () => resolve(Buffer.concat(chunks))); arc.on('error', reject);
    const used = new Set();
    for (const d of doc.docs) {
      for (const s of d.sections) {
        const lines = [];
        (s.cards || []).forEach(c => lines.push([csvCell(c.k), csvCell(c.v)].join(',')));
        if (s.table) {
          const t = s.table;
          lines.push([''].concat(t.heads, t.hasTotal ? ['Total'] : []).map(csvCell).join(','));
          t.rows.forEach(r => {
            const cells = r.cells.concat(t.hasTotal ? [r.tot || { f: 'text', v: '' }] : []);
            lines.push([csvCell(r.label)].concat(cells.map(c => csvCell(c.f === 'text' ? c.v : c.v === null ? '' : c.v))).join(','));
          });
        }
        if (!lines.length) continue;
        let n = safeName(d.name + ' - ' + (SHEETS[s.kind] || s.title)), k = n, i = 2;
        while (used.has(k)) k = n + ' ' + i++;
        used.add(k);
        arc.append('﻿' + lines.join('\r\n') + '\r\n', { name: k + '.csv' });
      }
    }
    if (!used.size) arc.append('No report data.\r\n', { name: 'empty.csv' });
    arc.finalize();
  });
}

async function buildReportFile(fmt, doc) {
  const base = safeName(doc.name);
  if (fmt === 'xlsx') return { filename: base + '.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await xlsx(doc) };
  if (fmt === 'pdf') return { filename: base + '.pdf', type: 'application/pdf', buffer: await pdf(doc) };
  return { filename: base + '.zip', type: 'application/zip', buffer: await zipCsv(doc) };
}

module.exports = { buildReportFile, safeName };
