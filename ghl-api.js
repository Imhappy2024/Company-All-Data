/* GHL leads, read from Supabase — brand-scoped.

   Mounted at /api/ghl. The data layer is `ghl-data.js`, ported from
   command-center's `lib/ghl-data.js`; this file is the read-only routing over
   it, rewritten rather than ported because command-center's `routes/ghl.js`
   drags in its webhook receiver, rate limiter, OAuth provider stack and send
   path — none of which can work here (see "no writes" below).

   ---------------------------------------------------------------------------
   EVERY REQUEST IS SCOPED TO ONE BRAND

   The portal is a brand-as-workspace shell, so the LeavenWealth workspace shows
   LeavenWealth's GHL sub-account and nobody else's. Verified against the live
   database on 2026-09-07 — `ghl_location.company_id` is populated on all three
   locations and points at the same four-brand `company` table the portal's
   BRAND_COMPANY_ID map uses:

     LeavenWealth  r7zMur27ESvHGQpOWI2F   1,231 leads   31 opps    0 messages
     Leadli AI     sR79W8mCX3gd5pWKG5wU   2,538 leads    0 opps    0 messages
     Folio Excel   xvWwoC1KQ1cOtw8Qf3Ez   4,643 leads    8 opps  111 messages
     Liquid Lending — no GHL location at all

   The scope resolves to a SET OF LOCATION IDS once per request, and every read
   below takes that set. `allowedLocationIds(companyId)` in the data layer is
   the gate the per-lead routes check, so a lead id naming another brand's
   location 404s rather than answering. Scoping only the list would leave
   /thread and /detail open to anyone who guesses an id.

   An unknown or absent company_id scopes to NOTHING rather than to everything.
   That is the safe direction: a bug that shows an empty screen gets reported,
   and a bug that shows Folio's 4,643 leads under LeavenWealth does not.

   ---------------------------------------------------------------------------
   READ-ONLY APART FROM ONE ROUTE

   POST /leads/:id/message reaches GHL to send, because GHL owns delivery. It is
   named explicitly in SEND_PATH so the default stays closed: every other
   non-GET is 405, and every SQL string is checked for a write verb before it
   reaches the pool, exactly as financials-api.js does and for the same reason —
   `supabase-db` connects as the postgres superuser, so a stray write has no
   database-side backstop.

   The send credential comes from GHL_TOKEN_<NAME> paired with
   GHL_LOCATION_<NAME>; see ghl-send.js.
   --------------------------------------------------------------------------- */

const express = require('express');
const db = require('./supabase-db');
const G = require('./ghl-data');
const SEND = require('./ghl-send');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const WRITE_SQL = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge)\b/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---- display strings ----------------------------------------------------
   Computed here, in AGENT_TIMEZONE, because the Leads view does no date
   arithmetic — it renders the string it is handed. */

/* Validated once, at load, because an unrecognised zone makes every
   Intl.DateTimeFormat below throw a RangeError — and these run per request, so
   a typo in a Railway variable would surface as the thread route 500ing rather
   than as a bad setting. "CST" is accepted by Intl; "Central" is not, and the
   difference is not guessable. Falls back to the server's own zone and says
   so, rather than taking the feature down over a formatting preference. */
const TZ = (() => {
  const want = process.env.AGENT_TIMEZONE;
  if (!want) return undefined;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: want }).format(new Date());
    return want;
  } catch (err) {
    console.warn('[ghl] AGENT_TIMEZONE=%s is not a time zone Node recognises (%s). '
      + 'Falling back to the server zone. Use an IANA name like America/Chicago.',
      want, err.message);
    return undefined;
  }
})();

const asDate = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d : null; };
const dayKey = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const monthDay = d => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(d);
const clock = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const fullDate = d => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' }).format(d);

function dayLabel(value, now = Date.now()){
  const d = asDate(value);
  if (!d) return '';
  const then = dayKey(d);
  if (then === dayKey(new Date(now))) return 'Today';
  if (then === dayKey(new Date(now - 86400000))) return 'Yesterday';
  return monthDay(d);
}
const clockLabel = value => { const d = asDate(value); return d ? clock(d) : ''; };
const longDate = value => { const d = asDate(value); return d ? fullDate(d) : ''; };

function relativeTime(ms){
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm';
  const h = Math.round(mins / 60);
  if (h < 24) return h + 'h';
  const d = Math.round(h / 24);
  return d < 7 ? d + 'd' : Math.round(d / 7) + 'w';
}

/* GHL email bodies are HTML. A thread bubble wants text, and rendering sender
   HTML inside the dashboard would be handing a stranger the page. */
function flatten(html){
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---- lead ids -----------------------------------------------------------
   `<locationId>:<contactId>` for a person, `<locationId>:o_<opportunityId>`
   for an opportunity whose contact never landed. The location is IN the id,
   which is exactly why the brand gate has to check it. */
function splitLeadId(raw){
  const s = String(raw || '');
  const at = s.indexOf(':');
  if (at < 1 || at === s.length - 1) return { locationId: null };
  const locationId = s.slice(0, at);
  const rest = s.slice(at + 1);
  return rest.startsWith('o_')
    ? { locationId, contactId: null, opportunityId: rest.slice(2) }
    : { locationId, contactId: rest, opportunityId: null };
}

function shapeLead(row){
  const sortKey = row.activity ? Date.parse(row.activity) : 0;
  return {
    id: `${row.location_id}:${row.contact_id || 'o_' + row.opportunity_id}`,
    loc: row.location_id,
    name: row.contact_name || row.opp_name || '(no name)',
    phone: row.phone || '',
    email: row.email || '',
    source: row.source || '',
    /* A name, never an id. Resolved in SQL through staff and ghl_user. */
    owner: row.contact_owner || row.opp_owner || '',
    /* GHL's own stage. A contact with no opportunity has NO stage — stage
       belongs to an opportunity, not to a person — and that is said with null
       rather than asserted as "new" about three thousand people. Only 28 of
       LeavenWealth's 1,231 leads have one. */
    stageId: row.stage_id || null,
    stageName: row.stage_name || null,
    /* open | won | lost | abandoned, from GHL. This, not the stage name,
       decides whether a lead is live: "Closed Won" as a stage name and a
       status of open do disagree in this data. */
    status: row.status || null,
    value: Number(row.value) || 0,           /* NUMERIC arrives from pg as text */
    tags: Array.isArray(row.tags) ? row.tags : [],
    last: relativeTime(sortKey),
    sortKey,
    unread: Boolean(row.last_in) &&
      (!row.last_out || Date.parse(row.last_in) > Date.parse(row.last_out)),
    created: longDate(row.date_added),
    /* A lead that knows its brand but not its GHL location. 33 such rows
       exist. They are listed — the contact detail is the point — but they have
       no location, so there is no thread and no pipeline record to open, and
       the client says that instead of firing a request that would 404. */
    noLocation: !row.location_id,
    ghlId: row.opportunity_id || null,
    contactId: row.contact_id || null,
    hasOpportunity: Boolean(row.opportunity_id),
    /* The delta cursor. The browser keeps the max it has seen and asks for
       rows changed after it — server clock, never the browser's. */
    changedAt: row.changed_at || null
  };
}

function ghlRoutes() {
  const r = express.Router();

  /* Read-only except for one route. POST /leads/:id/message reaches GHL to
     send, which is the single side effect this feature is allowed to have —
     everything else answers out of the Supabase mirror. Naming the exception
     here rather than dropping the guard keeps the default closed. */
  const SEND_PATH = /^\/leads\/[^/]+\/message\/?$/;

  r.use((req, res, next) => {
    const isSend = req.method === 'POST' && SEND_PATH.test(req.path);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isSend) {
      return res.status(405).set('Allow', 'GET, HEAD, POST /leads/:id/message')
        .json({ error: 'The GHL API is read-only apart from sending a message.' });
    }
    if (!db.enabled) {
      return res.status(503).json({
        configured: false,
        error: 'SUPABASE_DB_URL is not set, so there are no leads to read.'
      });
    }
    next();
  });

  const fail = (res, err) => {
    if (err && err.code === '22P02') return res.status(400).json({ error: 'That is not a valid id.' });
    console.error('[ghl]', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'ghl query failed' });
  };

  /* The brand, from the caller. Absent scopes to nothing rather than to
     everything — see the header. */
  const companyOf = req => {
    const v = String(req.query.company_id || '').trim();
    return UUID_RE.test(v) ? v : null;
  };

  /* WHO is calling, verified against Supabase Auth.

     This asks Supabase to validate the token rather than decoding it here. A
     JWT payload is base64, not a signature check — anyone can craft one — and
     the answer decides whose email goes on a message to a customer. Financials
     can afford an unverified read for an export label; this cannot.

     Returns null on anything unverifiable, so the caller answers 401 rather
     than sending as nobody. */
  async function callerIdentity(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    try {
      const r2 = await fetch(SUPABASE_URL + '/auth/v1/user', {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + m[1].trim() },
      });
      if (!r2.ok) return null;
      const u = await r2.json();
      return (u && u.email) ? { id: u.id, email: u.email } : null;
    } catch (err) {
      console.error('[ghl] could not verify the caller:', err.message);
      return null;
    }
  }

  /* Which locations this request may read, and which of them it asked for.
     `location` narrows WITHIN the brand and can never widen past it: the
     requested id has to already be in the brand's set. */
  async function scope(req) {
    const companyId = companyOf(req);
    /* No brand, no data. subAccounts(null, null) returns EVERY location — it
       is the unscoped call the Executive view would want — so falling through
       to it here would mean that dropping ?company_id, or fat-fingering it,
       silently answered with all three brands at once. Nothing in the portal
       makes that request (Executive Board has no Leads item), so the only way
       to arrive here unscoped is a bug or a hand-written URL, and both should
       get an empty screen rather than somebody else's leads. */
    if (!companyId) return { companyId: null, all: [], chosen: [], ids: [] };
    const all = await G.subAccounts(null, companyId);
    const which = String(req.query.location || 'all');
    const chosen = (!which || which === 'all') ? all : all.filter(a => a.id === which);
    return { companyId, all, chosen, ids: chosen.map(a => a.id) };
  }

  /* Resolves a lead id against the BRAND's allow-list, then against Supabase.
     The 404 for a location outside the brand is deliberate and is the same
     answer as a location that does not exist — a scoping boundary should not
     confirm that another brand's sub-account is real. */
  async function loadLead(rawId, companyId) {
    const parts = splitLeadId(rawId);
    if (!parts.locationId) return { error: 'malformed lead id', status: 400 };
    const allowed = await G.allowedLocationIds(companyId);
    if (!allowed.has(parts.locationId)) return { error: 'no such sub-account', status: 404 };
    const found = await G.loadLead(parts.locationId, parts);
    if (!found) return { error: 'no such lead', status: 404 };
    return found;
  }

  r.get('/locations', async (req, res) => {
    try {
      const { all, companyId } = await scope(req);
      const sendable = SEND.sendableLocationIds();
      res.json({
        /* sendable drives the composer and the sidebar's "read-only" note. It
           is a real credential check now, not a flat false. */
        locations: all.map(a => ({ ...a, sendable: sendable.has(a.id) })),
        /* Stated rather than implied. Liquid Lending has no GHL sub-account,
           and "no locations" has to be distinguishable from "the scope did not
           resolve" or the empty screen means two different things. */
        scoped: Boolean(companyId),
        scopeResolved: Boolean(companyId) && all.length > 0
      });
    } catch (err) { fail(res, err); }
  });

  r.get('/stages', async (req, res) => {
    try {
      const { ids } = await scope(req);
      if (!ids.length) return res.json({ stages: [] });
      const which = String(req.query.location || 'all');
      /* One location, or every location this brand owns. Never null, which in
         the data layer means "every location in the database". */
      const stages = which !== 'all' && ids.includes(which)
        ? await G.stageCounts(which)
        : (await Promise.all(ids.map(id => G.stageCounts(id)))).flat();
      res.json({ stages });
    } catch (err) { fail(res, err); }
  });

  r.get('/leads', async (req, res) => {
    try {
      const { ids, companyId } = await scope(req);
      /* NOT an early return on an empty id set any more. Liquid Lending has no
         ghl_location row at all and 8 leads that carry only a company_id;
         bailing here is what hid every one of them. */

      /* ?since=<iso> returns only rows changed after that instant. A malformed
         value is refused rather than treated as "everything", because the
         browser would then merge a full list believing it was a delta. */
      let since = null;
      if (req.query.since) {
        const t = Date.parse(String(req.query.since));
        if (Number.isNaN(t)) return res.status(400).json({ error: 'since must be an ISO timestamp' });
        since = new Date(t).toISOString();
      }

      /* One character is not a search, it is a request for most of the table
         rendered one row at a time. Below two it is ignored, and `search` in
         the response is what was APPLIED rather than what was typed — echoing
         back an ignored term is how a caller concludes the search is broken
         when it simply did not run. */
      const typed = String(req.query.q || '').trim();
      const search = typed.length >= 2 ? typed : null;

      const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 400));
      const rows = await G.leadRows(ids, limit, { since, search, companyId });

      res.json({
        leads: rows.map(shapeLead),
        delta: Boolean(since),
        search,
        searchIgnored: Boolean(typed) && !search,
        /* The authoritative count for this brand: what leadRows would return
           with no limit. The screen prints it beside the capped list, so it has
           to include the company-only rows that the list itself includes. */
        total: search ? rows.length : await G.leadTotal(ids, companyId)
      });
    } catch (err) { fail(res, err); }
  });

  r.get('/leads/:id/thread', async (req, res) => {
    try {
      const found = await loadLead(req.params.id, companyOf(req));
      if (found.error) return res.status(found.status).json({ error: found.error });
      if (!found.contactId) return res.json({ thread: [], activity: [], pending: [] });

      const rows = await G.threadFor(found.locationId, found.contactId);
      const thread = [];
      const activity = [];

      /* Messages and activity come back apart. TYPE_ACTIVITY_* rows are system
         events GHL files in the same table — opportunity moves, appointment
         bookings — and folding them into the bubbles makes a thread read as
         noise. */
      for (const m of rows) {
        const at = m.ghl_date_added;
        const common = { day: dayLabel(at), time: clockLabel(at), sentAt: at };
        if (G.isActivity(m.message_type)) {
          activity.push({ ...common, kind: G.activityLabel(m.message_type), body: flatten(m.body) });
          continue;
        }
        thread.push({
          ...common,
          dir: G.dirOf(m.direction),
          channel: G.channelOf(m.message_type),
          subject: m.subject || null,
          /* Flattened, never raw HTML: sender markup is not injected into the page. */
          body: m.content_type === 'text/html' ? flatten(m.body) : (m.body || ''),
          attachments: Array.isArray(m.attachments) ? m.attachments.length : 0,
          actor: m.actor || null,
          status: m.status || null
        });
      }

      const pending = (await G.pendingInbound(found.locationId, found.contactId)).map(p => ({
        day: dayLabel(p.ghl_date_added), time: clockLabel(p.ghl_date_added),
        channel: G.channelOf(p.message_type), body: flatten(p.body)
      }));

      res.json({ thread, activity, pending });
    } catch (err) { fail(res, err); }
  });

  r.get('/leads/:id/detail', async (req, res) => {
    try {
      const found = await loadLead(req.params.id, companyOf(req));
      if (found.error) return res.status(found.status).json({ error: found.error });
      if (!found.contactId) {
        return res.json({ fields: [], attribution: [], notes: [], tasks: [], appointments: [], conversations: [] });
      }

      const [fields, attribution, notes, tasks, appointments, conversations] = await Promise.all([
        G.customValuesFor(found.contactId),
        G.attributionFor(found.contactId),
        G.notesFor(found.contactId),
        G.tasksFor(found.contactId),
        G.appointmentsFor(found.contactId),
        G.conversationsFor(found.locationId, found.contactId)
      ]);

      res.json({
        /* Field name from the definition, never the raw JSON blob on lead. */
        fields: fields.map(f => ({
          name: f.name,
          value: f.value != null ? f.value : (f.value_json === null ? '' : JSON.stringify(f.value_json)),
          type: f.data_type || null
        })),
        /* Two rows per contact: first touch and last touch, kept separate
           because collapsing them loses the only interesting thing about
           attribution. */
        attribution,
        notes: notes.map(n => ({ ...n, when: longDate(n.ghl_date_added), body: flatten(n.body) })),
        tasks,
        appointments,
        conversations
      });
    } catch (err) { fail(res, err); }
  });

  /* ---- sending -----------------------------------------------------------

     The one route here that writes anything, and the one call in this feature
     that reaches GHL rather than Supabase, because GHL owns delivery.

     IT SENDS AS THE SIGNED-IN PERSON. `emailFrom` is the caller's own address,
     VERIFIED against Supabase Auth rather than decoded out of the JWT: this is
     an authorisation decision — whose name goes on a message to a customer —
     and an unverified decode would let anyone paste a token body and send as
     anyone. `exportedBy` in financials-api.js can afford an unverified read
     because it only labels a spreadsheet; this cannot.
  --------------------------------------------------------------------------- */

  r.post('/leads/:id/message', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const who = await callerIdentity(req);
      if (!who) {
        return res.status(401).json({
          error: 'Sign in to send. A message goes out under your own address, so it needs a verified session.',
          kind: 'auth',
        });
      }

      const found = await loadLead(req.params.id, companyOf(req));
      if (found.error) return res.status(found.status).json({ error: found.error });

      const { locationId, contactId } = found;
      if (!contactId) {
        return res.status(400).json({ error: 'This lead has no contact in GHL, so there is nobody to message.' });
      }

      const b = req.body || {};
      const channel = String(b.channel || 'sms').toLowerCase();
      const type = SEND.CHANNEL_TO_GHL[channel];
      if (!type) {
        return res.status(400).json({
          error: 'channel must be one of ' + Object.keys(SEND.CHANNEL_TO_GHL).join(', '),
        });
      }

      const isEmail = channel === 'email';
      const text = String(b.body == null ? '' : b.body).trim();
      const html = String(b.html == null ? '' : b.html).trim();
      const subject = String(b.subject == null ? '' : b.subject).trim();

      if (!text && !html) return res.status(400).json({ error: 'Nothing to send.' });

      /* Blocked here with a reason rather than sent without one and quietly
         filed by GHL as '(no subject)'. */
      if (isEmail && !subject) {
        return res.status(400).json({ error: 'A subject is required for email.', kind: 'validation', field: 'subject' });
      }

      /* Being listed and being sendable are different things. A sub-account is
         readable because the pipeline ingested it; sending needs a token. Said
         BEFORE the attempt, because the alternative is a bare 401 from GHL that
         reads like the message was rejected rather than never sent. */
      if (!SEND.sendableLocationIds().has(locationId)) {
        return res.status(400).json({
          error: 'No GHL send token for this sub-account. Reading works without one; sending needs '
            + 'GHL_TOKEN_<NAME> paired with GHL_LOCATION_<NAME>=' + locationId
            + ' and the conversations/message.write scope.',
          kind: 'validation',
        });
      }

      let sent;
      try {
        sent = await SEND.sendMessage(SEND.tokenFor(locationId), {
          type,
          contactId,
          message: isEmail ? undefined : text,
          html: isEmail ? (html || text) : undefined,
          subject: isEmail ? subject : undefined,
          /* The signed-in person's own address.

             NOT validated against the sub-account's known senders first, and
             that is deliberate. GHL is the only authority on which addresses it
             has verified, the mirror's `ghl_location.email` holds one address
             per location (LeavenWealth's is lauren@wellspentconsulting.com),
             and `ghl_user` is empty for LeavenWealth entirely — so a local
             check would refuse every send this dashboard exists to make, on
             data that cannot answer the question. GHL decides, and its refusal
             is passed back verbatim. */
          emailFrom: isEmail ? who.email : undefined,
          emailTo: isEmail ? (String(b.to || '').trim() || undefined) : undefined,
          emailCc: isEmail ? b.cc : undefined,
          emailBcc: isEmail ? b.bcc : undefined,
        });
      } catch (err) {
        /* Surfaced, never swallowed. A silent failure on an outbound message is
           worse than an error, because the operator believes it went. */
        console.error('[ghl:send] failed location=%s contact=%s channel=%s by=%s: %s',
          locationId, contactId, channel, who.email, err.message);
        const status = err.kind === 'auth' ? 502 : (err.status && err.status < 500 ? 400 : 502);
        return res.status(status).json({
          error: err.kind === 'auth'
            ? 'GHL rejected the send token for this sub-account. It has been rotated or revoked, '
              + 'so GHL_TOKEN_* needs a fresh Private Integration Token.'
            : err.message,
          kind: err.kind || 'other',
        });
      }

      /* Every send is logged. An outbound message is an action taken on a
         customer's behalf and needs a trail independent of GHL. */
      console.log('[ghl:send] ok location=%s contact=%s type=%s message=%s by=%s',
        locationId, contactId, type, sent.messageId, who.email);

      const sentAt = new Date().toISOString();

      /* Echo suppression. GHL's own id is the key, so the OutboundMessage
         webhook that follows carries the same id and ON CONFLICT DO NOTHING
         makes it a no-op.

         ghl_message.ghl_conversation_id is NOT NULL and conversationId is a
         response-only field, so when GHL does not return one there is nowhere
         to put the row. Skipped rather than invented: the webhook inserts it
         once, which is correct, just slower. A fabricated id would split one
         conversation into two. */
      if (sent.conversationId) {
        try {
          await db.q(
            `insert into public.ghl_message
                    (ghl_message_id, ghl_location_id, ghl_contact_id, ghl_conversation_id,
                     direction, message_type, body, subject, ghl_date_added, status)
             values ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8::timestamptz, 'pending')
             on conflict (ghl_message_id) do nothing`,
            [sent.messageId, locationId, contactId, sent.conversationId,
             'TYPE_' + String(type).toUpperCase(),
             isEmail ? (html || text) : text,
             isEmail ? subject : null, sentAt]);
        } catch (err) {
          /* The message IS sent. Failing the request now would tell the
             operator it was not, and they would send it again. */
          console.error('[ghl:send] sent but not recorded (%s): %s', sent.messageId, err.message);
        }
      }

      res.json({
        ok: true,
        messageId: sent.messageId,
        conversationId: sent.conversationId,
        recorded: Boolean(sent.conversationId),
        from: isEmail ? who.email : null,
        sentAt,
      });
    } catch (err) { fail(res, err); }
  });

  /* Ingest health, out of ghl_sync_log. Not a sync this dashboard runs — it
     cannot start, stop or retry one, and the UI does not pretend otherwise. */
  r.get('/sync', async (req, res) => {
    try { res.json({ ingest: await G.ingestStatus() }); }
    catch (err) { fail(res, err); }
  });

  return r;
}

module.exports = { ghlRoutes, splitLeadId, shapeLead, flatten, relativeTime, WRITE_SQL };
