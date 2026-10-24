'use strict';
// Ask AQUIQ: answers a customer's question about the AQUIQ service from the knowledge base
// and from that customer's own visit log and open request. With an ANTHROPIC_API_KEY it uses
// an AI model; without one it answers from the knowledge base directly.

const axios = require('axios');
const { search, asPromptText } = require('./askKnowledge');

const DAILY_LIMIT = 40;           // questions per store per day (keeps AI cost bounded)
const MODEL = process.env.ASK_MODEL || 'claude-haiku-5-5';

const dateOf = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));

function contextText({ store, rows, active, now }) {
  const lines = [];
  lines.push(`Today is ${dateOf(now)}. The customer's store is "${store.name || 'their store'}".`);
  if (active) {
    lines.push(`OPEN SERVICE REQUEST: ticket ${active.ticket_no}, status "${active.status_label}", problem "${active.issue_category}", raised ${dateOf(active.created_at)}`
      + (active.engineer_name ? `, engineer ${active.engineer_name}` : '')
      + (active.engineer_location && active.engineer_location.eta_minutes != null ? `, about ${active.engineer_location.eta_minutes} minutes away (${active.engineer_location.distance_km} km)` : '')
      + '.');
  } else {
    lines.push('There is no open service request right now.');
  }
  if (!rows.length) lines.push('VISIT LOG: no visits recorded yet.');
  else {
    lines.push('VISIT LOG (newest first):');
    rows.slice(0, 10).forEach((r, i) => {
      lines.push(`${i + 1}. ${dateOf(r.at)} — ${r.kind === 'aquiq' ? `AQUIQ service ${r.ticket_no}` : 'visit logged by the customer'}`
        + (r.engineer ? ` — engineer ${r.engineer}` : '') + (r.issue ? ` — ${r.issue}` : '') + (r.notes && r.kind === 'manual' ? ` (${r.notes})` : ''));
    });
  }
  return lines.join('\n');
}

const SYSTEM = (kb) => `You are "Ask AQUIQ", the helpful assistant inside the AQUIQ customer app (a product of AQUIQ, powered by PR SONS). You answer questions about AQUIQ's service system: requesting service, engineers and their rules (SOP), approvals, service reports, the Visit Log, ratings, storage policy, recent updates, and the customer's own visit history.

RULES
- Use ONLY the facts in KNOWLEDGE and CUSTOMER CONTEXT below. Never invent prices, dates, names or promises.
- Be short and clear: normally 2 to 6 lines. Use simple words. Answer in the language the customer wrote in (English, Hindi, or Hinglish).
- For "who serviced last / when was the last service", answer from the VISIT LOG: name the engineer, the date and the problem.
- Never share an engineer's phone number or any other customer's information.
- If the answer is not in the facts, say so politely and give the support contact (careprtech@hotmail.com or info@prtechno.in, Mon–Sat 10 AM–6 PM IST).
- Questions about live water readings (TDS, membrane, pump, flow) are answered elsewhere in the app; if asked, tell them to ask for "overall health" or "TDS".

KNOWLEDGE
${kb}`;

function createAskService({ now = () => new Date(), env = process.env, http = axios, log = console } = {}) {
  const used = new Map();     // `${store}|${yyyy-mm-dd}` -> count

  function allow(storeId) {
    const day = new Date(now().getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
    const key = `${storeId}|${day}`;
    const n = (used.get(key) || 0) + 1;
    used.set(key, n);
    for (const k of used.keys()) if (!k.endsWith(day)) used.delete(k);
    return n <= DAILY_LIMIT;
  }

  // the visit-log question, answered without an AI model (also the safety net)
  function fromContext(question, { rows, active }) {
    const q = String(question || '').toLowerCase();
    if (/(last|previous|recent|latest|kisne|kaun|who).*(servic|visit|came|aaya|repair)|visit log|service history/.test(q)) {
      const aq = rows.filter(r => r.kind === 'aquiq');
      const r = aq[0] || rows[0];
      if (!r) return 'There are no visits recorded for your store yet. When an AQUIQ engineer completes a service, it appears in your Visit Log.';
      const more = rows.length > 1 ? `\n\nYou have ${rows.length} visits in your Visit Log (Service History → Visit Log).` : '';
      return `Your last service was on ${dateOf(r.at)}${r.engineer ? ` by ${r.engineer}` : ''}${r.issue ? ` for "${r.issue}"` : ''}${r.ticket_no ? ` (ticket ${r.ticket_no})` : ''}.${more}`;
    }
    if (/(status|where|eta|how long|kab|coming|track).*(request|engineer|ticket|service)?|my request|my ticket/.test(q) && active) {
      let a = `Your request ${active.ticket_no} is "${active.status_label}"`;
      if (active.engineer_name) a += `, with engineer ${active.engineer_name}`;
      const l = active.engineer_location;
      if (l && l.eta_minutes != null) a += `. They are about ${l.eta_minutes} minutes away (${l.distance_km} km).`;
      else a += '.';
      return a;
    }
    return null;
  }

  async function llm(question, ctx, history) {
    const messages = [];
    for (const h of (history || []).slice(-6)) {
      if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string') {
        messages.push({ role: h.role, content: h.text.slice(0, 800) });
      }
    }
    messages.push({ role: 'user', content: `CUSTOMER CONTEXT\n${ctx}\n\nQUESTION\n${String(question).slice(0, 600)}` });
    const res = await http.post('https://api.anthropic.com/v1/messages', {
      model: MODEL, max_tokens: 450, system: SYSTEM(asPromptText()), messages,
    }, {
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 25000,
    });
    const part = res.data && res.data.content && res.data.content.find(c => c.type === 'text');
    return part ? String(part.text).trim() : null;
  }

  async function answer({ storeId, question, history, store, rows, active }) {
    if (!allow(storeId)) {
      return { answer: 'You have reached today\'s question limit for Ask AQUIQ. Please try again tomorrow, or write to careprtech@hotmail.com.', mode: 'limit' };
    }
    const ctx = contextText({ store, rows, active, now: now() });
    if (env.ANTHROPIC_API_KEY) {
      try {
        const a = await llm(question, ctx, history);
        if (a) return { answer: a, mode: 'ai' };
      } catch (e) { log.error('[ASK] model error:', e.message); }
    }
    const direct = fromContext(question, { rows, active });
    if (direct) return { answer: direct, mode: 'rules' };
    const k = search(question);
    if (k) return { answer: k.text, mode: 'rules' };
    return {
      answer: 'I could not find that in my service information. You can ask me about requesting a service, your visit log and last service, engineer rules, reports, ratings, how long photos are kept, or what is new. For anything else, write to careprtech@hotmail.com or info@prtechno.in (Mon–Sat, 10 AM–6 PM IST).',
      mode: 'rules',
    };
  }

  return { answer, fromContext, contextText };
}

module.exports = { createAskService, DAILY_LIMIT };
