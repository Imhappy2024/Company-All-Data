// ===========================================================================
// report-mailer.js — hands a report file to the n8n workflow
// "Report email (dashboard reports)" (ghGUvzmOC19PUwMO), which sends it from
// the Outlook "Jay" mailbox (Microsoft Graph sendMail) with the file attached. Also sends the plain
// notice to a schedule's owner when a scheduled send fails.
//
//   REPORT_EMAIL_SECRET       shared with the workflow; required
//   REPORT_EMAIL_WEBHOOK_URL  optional; defaults to the production webhook
// ===========================================================================
'use strict';

const DEFAULT_URL = 'https://leavenwealth.app.n8n.cloud/webhook/report-email-k3r8w2m5';
const MAX_BYTES = 3 * 1024 * 1024;    // Microsoft Graph sendMail takes attachments up to 3 MB inline

const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function bodyHtml(text, footer) {
  const paras = String(text || '').trim().split(/\r?\n\s*\r?\n/).filter(Boolean)
    .map(p => '<p style="margin:0 0 12px">' + esc(p).replace(/\r?\n/g, '<br>') + '</p>').join('');
  return '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#16191d">' + paras +
    '<p style="margin:16px 0 0;color:#5d5b56;font-size:12.5px">' + esc(footer) + '</p></div>';
}

async function post(payload) {
  const secret = process.env.REPORT_EMAIL_SECRET;
  if (!secret) throw new Error('email is not configured on this deployment (REPORT_EMAIL_SECRET)');
  let r;
  try {
    r = await fetch(process.env.REPORT_EMAIL_WEBHOOK_URL || DEFAULT_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-report-email-secret': secret }, body: JSON.stringify(payload),
    });
  } catch (e) { throw new Error('could not reach the email service'); }
  if (!r.ok) {
    let msg = ''; try { const b = await r.json(); msg = b && (b.message || b.error) || ''; } catch (e) { /* not json */ }
    throw new Error('the email service answered ' + r.status + (msg ? ': ' + String(msg).slice(0, 200) : ''));
  }
}

async function sendReport({ to, cc, bcc, subject, body, file, senderName, footer }) {
  if (file.buffer.length > MAX_BYTES) throw new Error('the file is ' + (file.buffer.length / 1048576).toFixed(1) + ' MB; the limit for email is 3 MB. Choose fewer properties, or export it instead.');
  await post({
    to, cc: cc || [], bcc: bcc || [], subject,
    html: bodyHtml(body, footer || ('Sent from the LeavenWealth dashboard' + (senderName ? ' by ' + senderName : '') + '.')),
    filename: file.filename, mime: file.type, data: file.buffer.toString('base64'),
  });
}

/* a failed scheduled send: the owner hears about it. The workflow requires an
   attachment, so the notice carries a short text file with the details. */
async function sendFailureNotice({ to, scheduleName, error, when }) {
  const text = 'Schedule: ' + scheduleName + '\r\nAttempted: ' + when + ' (Central)\r\nReason: ' + error + '\r\n';
  await post({
    to: [to], cc: [], bcc: [], subject: 'Scheduled report not sent: ' + scheduleName,
    html: bodyHtml('The scheduled report "' + scheduleName + '" could not be sent on ' + when + ' (Central time).\n\nReason: ' + error +
      '\n\nIt will try again on its next due date. You can pause, change or delete it under Properties, Reports, Scheduled.',
      'Sent automatically by the LeavenWealth dashboard.'),
    filename: 'details.txt', mime: 'text/plain', data: Buffer.from(text).toString('base64'),
  });
}

module.exports = { sendReport, sendFailureNotice, MAX_BYTES };
