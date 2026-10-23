'use strict';
// Tickets raised by EMAIL to r-tickets@. A small Google Apps Script in the AQUIQ mailbox posts every new
// mail here (see tools/inbound-gmail.gs). Rules:
//   - a reply that mentions an existing PMR number is added to that ticket as a note (never a new ticket)
//   - a sender registered in AQUIQ (a store's confirmed email, or a company account with ONE store) gets a normal ticket
//   - any other sender still gets a ticket, marked EXTERNAL-UNVERIFIED IN AQUIQ SYSTEM; an admin links it to a store later
//   - bounces, auto-replies and our own addresses are ignored (so mail can never loop); one sender may raise 5 a day

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PMR_RE = /\bPMR\d{8,}\b/i;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const DEFAULT_OWN = [
  'r-tickets@aquiq-prsons.com', 'service.bharat@aquiq-prsons.com', 'info.fs.reports-no-reply@aquiq-prsons.com',
  'careaquiq-prsons@aquiq-prsons.com', 'care@aquiq-prsons.com', 'no-reply@aquiq-prsons.com',
];

function createInboundService(store, tickets, { env = process.env, now = () => new Date(), log = console } = {}) {
  const own = new Set(String(env.INBOUND_OWN_ADDRESSES || DEFAULT_OWN.join(',')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const maxPerDay = Number(env.INBOUND_MAX_PER_DAY) || 5;

  // Why a mail must NOT become a ticket (null = fine)
  function skipReason(m) {
    if (own.has(m.from_email)) return 'own_address';
    if (/^(mailer-daemon|postmaster)@/i.test(m.from_email)) return 'bounce';
    if (/(^|[._-])(no-?reply|do-?not-?reply|donotreply)@/i.test(m.from_email)) return 'no_reply_sender';
    if (/^(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice)/i.test(m.subject)) return 'bounce';
    if (/^(automatic reply|auto:|auto-reply|autoreply|out of office)/i.test(m.subject)) return 'auto_reply';
    const auto = String(m.auto_submitted || '').trim().toLowerCase();
    if (auto && auto !== 'no') return 'auto_reply';
    if (/^(bulk|junk|list|auto_reply)$/i.test(String(m.precedence || '').trim())) return 'bulk';
    return null;
  }

  // Which store does this sender belong to? -> { store, hint }
  async function matchSender(email) {
    const stores = await store.findStoresByVerifiedEmail(email);
    if (stores.length === 1) return { store: stores[0], hint: null };
    if (stores.length > 1) return { store: null, hint: `This email is confirmed on ${stores.length} stores. Choose the right store.` };
    const uhad = await store.findUhadByEmail(email);
    if (uhad) {
      const mine = await store.listStoresOfUhad(uhad.id);
      if (mine.length === 1) return { store: mine[0], hint: null };
      return { store: null, hint: `Company account ${uhad.company || uhad.name || ''} (${mine.length} stores). Choose the right store.`.replace('  ', ' ') };
    }
    return { store: null, hint: null };
  }

  async function handle(raw) {
    const m = {
      message_id: String(raw.message_id || '').trim().slice(0, 300),
      from_email: String(raw.from_email || '').trim().toLowerCase(),
      from_name: String(raw.from_name || '').trim().slice(0, 120),
      subject: String(raw.subject || '').trim().slice(0, 300),
      body: String(raw.body || '').slice(0, 4000),
      auto_submitted: raw.auto_submitted, precedence: raw.precedence,
    };
    if (!m.message_id) throw httpError(400, 'message_id is required.');
    if (!EMAIL_RE.test(m.from_email)) throw httpError(400, 'A valid from_email is required.');

    // claim the message first: the same mail is never handled twice, even if the script retries
    const claimed = await store.claimInbound({ message_id: m.message_id, from_email: m.from_email, subject: m.subject.slice(0, 200), outcome: 'processing' });
    if (!claimed) return { outcome: 'duplicate' };

    try {
      const why = skipReason(m);
      if (why) { await store.finishInbound(m.message_id, { outcome: 'ignored', reason: why }); return { outcome: 'ignored', reason: why }; }

      // a reply to an existing ticket becomes a note on it
      const ref = (m.subject.match(PMR_RE) || m.body.match(PMR_RE) || [])[0];
      if (ref) {
        const t = await tickets.getByNumber(ref.toUpperCase());
        if (t) {
          const registered = t.customer_id ? await store.getCustomerEmail(t.customer_id).catch(() => null) : null;
          const known = [t.contact_email, registered].filter(Boolean).map(x => String(x).toLowerCase()).includes(m.from_email);
          const text = `${known ? '' : `[Sender ${m.from_email} is not the ticket's registered contact] `}Email: ${m.body.replace(/\s+/g, ' ').trim()}`.slice(0, 1000);
          await tickets.act(t.id, { action: 'note', note: text || 'Email received (no text).' }, { email: `email: ${m.from_email}`, role: 'customer' });
          await store.finishInbound(m.message_id, { outcome: 'note_added', ticket_id: t.id });
          return { outcome: 'note_added', ticket_no: t.ticket_no };
        }
      }

      const since = new Date(now().getTime() - 24 * 3600 * 1000).toISOString();
      if (await store.countTicketsFromSince(m.from_email, since) >= maxPerDay) {
        await store.finishInbound(m.message_id, { outcome: 'rate_limited', reason: `more than ${maxPerDay} in 24h` });
        return { outcome: 'rate_limited' };
      }

      const match = await matchSender(m.from_email);
      const t = await tickets.createFromEmail({ store: match.store, hint: match.hint, from_name: m.from_name, from_email: m.from_email, subject: m.subject, body: m.body });
      await store.finishInbound(m.message_id, { outcome: match.store ? 'ticket_created' : 'ticket_unverified', ticket_id: t.id, reason: match.hint });
      return { outcome: match.store ? 'ticket_created' : 'ticket_unverified', ticket_no: t.ticket_no };
    } catch (err) {
      await store.releaseInbound(m.message_id).catch(() => {});      // let the script retry this mail
      log.error('[INBOUND]', m.message_id, err.message);
      throw err;
    }
  }

  return { handle, skipReason };
}

// ── Supabase store ───────────────────────────────────────────────────────────

function supabaseInboundStore(sb) {
  const one = async (q) => { const { data, error } = await q; if (error) { const e = httpError(500, 'Database error.'); e.detail = error.message; throw e; } return data; };
  return {
    async claimInbound(row) {
      const { error } = await sb.from('inbound_emails').insert([row]);
      if (!error) return true;
      if (error.code === '23505') return false;                              // already handled
      const e = httpError(error.code === '42P01' || error.code === 'PGRST205' ? 503 : 500,
        error.code === '42P01' || error.code === 'PGRST205' ? 'Email tickets are not set up yet. Run the SQL migration 2026-10-23_email_tickets.sql in Supabase first.' : 'Database error.');
      e.detail = error.message; throw e;
    },
    async finishInbound(id, patch) { await one(sb.from('inbound_emails').update(patch).eq('message_id', id)); },
    async releaseInbound(id) { await one(sb.from('inbound_emails').delete().eq('message_id', id)); },
    async countTicketsFromSince(email, sinceIso) {
      const { count, error } = await sb.from('inbound_emails').select('message_id', { count: 'exact', head: true })
        .eq('from_email', email).in('outcome', ['ticket_created', 'ticket_unverified']).gte('received_at', sinceIso);
      if (error) throw httpError(500, 'Database error.');
      return count || 0;
    },
    async findStoresByVerifiedEmail(email) {
      return (await one(sb.from('customers').select('*').eq('email', email).not('email_verified_at', 'is', null).limit(5))) || [];
    },
    async findUhadByEmail(email) { return one(sb.from('uhads').select('id,name,company').eq('email', email).maybeSingle()); },
    async listStoresOfUhad(uhadId) { return (await one(sb.from('customers').select('*').eq('uhad_id', uhadId).limit(50))) || []; },
  };
}

// ── HTTP layer: POST /inbound/email, protected by a shared secret (not by admin login) ──

function createInboundRouter(service, { env = process.env } = {}) {
  const express = require('express');
  const router = express.Router();
  router.post('/email', async (req, res) => {
    const secret = String(env.INBOUND_SECRET || '');
    if (secret.length < 16) return res.status(503).json({ error: 'Inbound email is not set up (INBOUND_SECRET missing).' });
    const given = Buffer.from(String(req.headers['x-inbound-secret'] || ''));
    const want = Buffer.from(secret);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'Not allowed.' });
    try { res.json(await service.handle(req.body || {})); }
    catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' }); }
  });
  return router;
}

module.exports = { createInboundService, supabaseInboundStore, createInboundRouter, PMR_RE };
