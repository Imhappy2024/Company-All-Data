/* Sending a message to GoHighLevel.

   This is the ONE call in the whole GHL feature that reaches GHL rather than
   Supabase, because GHL owns delivery. Everything else on the Leads screen
   reads the mirror.

   ---------------------------------------------------------------------------
   THE CREDENTIAL

   A GHL Private Integration Token per sub-account, from the environment, in the
   pairs command-center established and that are already set on Railway:

     GHL_TOKEN_LEAVENWEALTH    / GHL_LOCATION_LEAVENWEALTH
     GHL_TOKEN_LEADLI          / GHL_LOCATION_LEADLI
     GHL_TOKEN_FOLIO_EXCEL     / GHL_LOCATION_FOLIO_EXCEL
     GHL_TOKEN_LIQUID_LENDING  / GHL_LOCATION_LIQUID_LENDING

   The suffix is arbitrary and only pairs the two halves; what matters is that
   GHL_LOCATION_<X> holds the ghl_location_id the token can send from. A pair
   missing either half is skipped and named in the log rather than failing boot,
   because reading works without any token at all.

   A PIT is not OAuth. Nothing renews it, and a rotation in GHL just starts
   failing — so a 401 is surfaced as "reconnect this sub-account" rather than
   retried.

   ---------------------------------------------------------------------------
   THE Version HEADER IS REQUIRED

   GHL runs two API generations at once and omitting the header produces
   failures that look like auth problems and are not. Worse, several endpoints
   answer 200 with an empty body instead of erroring, which is indistinguishable
   from "you have no data". POST /conversations/messages is v3.
   --------------------------------------------------------------------------- */

const BASE = 'https://services.leadconnectorhq.com';
const V3 = 'v3';

/* ---- credentials --------------------------------------------------------- */

let tokensCache = null;

/* Read once. The environment does not change under a running process, and
   re-scanning it per send would only make the log noisier. */
function tokensByLocation() {
  if (tokensCache) return tokensCache;
  const out = new Map();
  const problems = [];
  for (const key of Object.keys(process.env)) {
    const m = /^GHL_TOKEN_(.+)$/.exec(key);
    if (!m) continue;
    const suffix = m[1];
    const token = String(process.env[key] || '').trim();
    const loc = String(process.env['GHL_LOCATION_' + suffix] || '').trim();
    if (!token) continue;                       /* declared but empty: not set up */
    if (!loc) {
      problems.push(`GHL_TOKEN_${suffix} has no GHL_LOCATION_${suffix}, so nothing can send with it`);
      continue;
    }
    out.set(loc, { token, suffix });
  }
  for (const p of problems) console.warn('[ghl-send] %s', p);
  tokensCache = { map: out, problems };
  return tokensCache;
}

const tokenFor = locationId => (tokensByLocation().map.get(locationId) || {}).token || null;
const sendableLocationIds = () => new Set(tokensByLocation().map.keys());

/* ---- the call ------------------------------------------------------------ */

class GhlError extends Error {
  constructor(message, { status, kind }) {
    super(message);
    this.status = status;
    this.kind = kind;                 /* auth | scope | notfound | rate | other */
  }
}

function classify(status) {
  if (status === 401) return 'auth';
  if (status === 403) return 'scope';
  if (status === 404) return 'notfound';
  if (status === 429) return 'rate';
  return 'other';
}

async function call(token, path, { method = 'GET', body, version = V3 } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Version: version,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

  if (!r.ok) {
    /* GHL's own message, not a generic one. It is usually specific ("Invalid
       emailFrom") and the operator can act on it; replacing it with "send
       failed" throws away the only useful part. */
    const msg = (data && (data.message || data.error))
      || (text && text.slice(0, 300))
      || (r.status + ' ' + r.statusText);
    throw new GhlError(String(msg), { status: r.status, kind: classify(r.status) });
  }
  return data;
}

const asArray = v => (Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []));

const CHANNEL_TO_GHL = { sms: 'SMS', email: 'Email', wa: 'WhatsApp', fb: 'FB', ig: 'IG' };

/* `status: 'pending'` is required, not optional — omitting it is rejected — and
   it is the honest value for a message just handed over. GHL moves it to
   delivered or failed itself. */
async function sendMessage(token, {
  type, contactId, message, html, subject,
  emailFrom, emailTo, emailCc, emailBcc, attachments, fromNumber,
} = {}) {
  const body = { type, contactId, status: 'pending' };

  if (type === 'Email') {
    /* html is the email body. Putting HTML in `message` sends the markup as
       plain text, which is what "the email arrived full of tags" looks like. */
    if (html) body.html = html;
    if (message && !html) body.message = message;
    if (subject) body.subject = subject;
    if (emailFrom) body.emailFrom = emailFrom;
    if (emailTo) body.emailTo = emailTo;
    if (asArray(emailCc).length) body.emailCc = asArray(emailCc);     /* arrays, not CSV */
    if (asArray(emailBcc).length) body.emailBcc = asArray(emailBcc);
  } else {
    body.message = message;
    /* Left unset, GHL sends from the sub-account's configured number. Naming
       one would mean guessing at its telephony setup. */
    if (fromNumber) body.fromNumber = fromNumber;
  }

  if (asArray(attachments).length) body.attachments = asArray(attachments);

  const data = await call(token, '/conversations/messages', { method: 'POST', body, version: V3 });

  const id = data && (data.messageId || (data.msg && data.msg.id) || (data.message && data.message.id) || data.id);
  if (!id) {
    /* Accepted but unrecordable. Saying so beats reporting success for
       something that cannot be written into the thread. */
    throw new GhlError('GHL accepted the send but returned no message id, so it cannot be recorded.',
      { status: 200, kind: 'other' });
  }
  return {
    messageId: String(id),
    /* Response-only, and the only place a conversation id may come from. */
    conversationId: data.conversationId ? String(data.conversationId) : null,
  };
}

module.exports = {
  tokenFor, sendableLocationIds, sendMessage, GhlError, CHANNEL_TO_GHL,
  /* For the diagnostics route: which pairs resolved, and what is malformed. */
  credentialReport: () => {
    const { map, problems } = tokensByLocation();
    return { locations: [...map.keys()], suffixes: [...map.values()].map(v => v.suffix), problems };
  },
};
