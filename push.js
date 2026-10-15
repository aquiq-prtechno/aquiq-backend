'use strict';
// Phone push notifications for the AQUIQ SE-TECH app (through Expo's push service, which
// delivers via Firebase on Android). Nothing here can break a ticket: every send is
// best-effort and errors are only logged.
//
// What goes in a notification: ticket number, problem type and the area only. Never the
// customer's name, phone or address.

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const CHANNEL = 'complaints_v3';           // must match the channel created by the app
const SOUND = 'aquiq_ring.wav';            // AQUIQ alert sound bundled in the engineer app

function createPushService(store, { send, enabled = true, log = console } = {}) {
  const doSend = send || (async (messages) => {
    const axios = require('axios');
    const res = await axios.post(EXPO_URL, messages, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 15000,
    });
    return res.data && res.data.data;
  });

  async function toEngineers(engineerIds, payload) {
    if (!enabled || !engineerIds.length) return { sent: 0 };
    const devices = await store.listDevices(engineerIds);
    const tokens = [...new Set(devices.map(d => d.token))].filter(t => /^Expo(nent)?PushToken\[.+\]$/.test(t));
    if (!tokens.length) return { sent: 0 };
    const messages = tokens.map(to => ({
      to, title: payload.title, body: payload.body, sound: SOUND, priority: 'high', channelId: CHANNEL,
      data: { ticket_id: payload.ticket_id, ticket_no: payload.ticket_no, kind: payload.kind },
    }));
    const dead = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const receipts = await doSend(chunk);
      (receipts || []).forEach((r, j) => {
        if (r && r.status === 'error' && r.details && r.details.error === 'DeviceNotRegistered') dead.push(chunk[j].to);
      });
    }
    if (dead.length) await store.deleteDevices(dead).catch(() => {});
    return { sent: tokens.length };
  }

  const safe = (p) => p.catch((e) => { log.error('[PUSH]', e.message); return { sent: 0, error: e.message }; });
  const area = (t) => [t.pincode, t.issue_category].filter(Boolean).join(' · ');

  return {
    toEngineers,
    // a new complaint: every active registered engineer who covers the site
    newComplaint: (ticket, engineerIds) => safe(toEngineers(engineerIds, {
      title: ticket.urgency === 'urgent' ? 'URGENT complaint nearby' : 'New complaint nearby',
      body: `${ticket.ticket_no} · ${area(ticket)}`, ticket_id: ticket.id, ticket_no: ticket.ticket_no, kind: 'new',
    })),
    // admin assigned the job to this engineer
    assigned: (ticket, engineerId) => safe(toEngineers([engineerId], {
      title: 'A job was assigned to you', body: `${ticket.ticket_no} · ${area(ticket)}`,
      ticket_id: ticket.id, ticket_no: ticket.ticket_no, kind: 'assigned',
    })),
    // customer not satisfied: back to the engineer who did it
    reopened: (ticket, engineerId) => safe(toEngineers([engineerId], {
      title: 'Customer is not satisfied', body: `${ticket.ticket_no} needs another visit`,
      ticket_id: ticket.id, ticket_no: ticket.ticket_no, kind: 'reopened',
    })),
  };
}

module.exports = { createPushService, CHANNEL };
