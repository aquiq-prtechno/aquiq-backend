'use strict';
// What "Ask AQUIQ" knows about the service side of AQUIQ, written for customers.
// Keep this file up to date when something changes: it is the assistant's memory.

const KNOWLEDGE = [
  {
    id: 'about', title: 'About AQUIQ',
    keywords: ['what is aquiq', 'about aquiq', 'what does aquiq', 'aquiq kya', 'aquiq ke bare'],
    text: 'AQUIQ monitors your RO water purifier all day: TDS, membrane health, pump, flow and more. It alerts you when something needs attention, prepares monthly reports, lets you request a service engineer in the app, and answers your questions here in Ask AQUIQ.',
  },
  {
    id: 'cancel', title: 'Cancelling a service request',
    keywords: ['cancel', 'cancel request', 'cancel order', 'cancel service', 'cancel complaint', 'cancel ticket', 'withdraw', 'dont need', 'don\'t need', 'changed my mind', 'not needed', 'stop request'],
    text: 'To cancel, open the app, go to Request Service and tap "Cancel request" at the bottom of the card, then confirm. You can cancel while the request is waiting for an engineer or the engineer is on the way. The engineer is told at once and you get a confirmation email. Once the engineer has reached your site or finished the work it can no longer be cancelled in the app, so please call AQUIQ support. After cancelling you can raise a new request any time.',
  },
  {
    id: 'request', title: 'How to request a service',
    keywords: ['request', 'book', 'service', 'complaint', 'raise', 'ticket', 'r-tickets', 'raise by email', 'email a complaint', 'mail a complaint', 'email to raise', 'raise a ticket by email', 'complaint by email', 'engineer bulana', 'problem', 'issue', 'how do i request', 'how to request', 'how to book'],
    text: 'You can also raise a request by email: write to r-tickets@aquiq-prsons.com with the problem in the subject (put URGENT in the subject if there is no water). You get a confirmation mail with your PMR ticket number. If you write from an email address that is not registered in AQUIQ, the ticket is still created but marked EXTERNAL-UNVERIFIED until our team links it to your store, so it is best to write from the email registered on your account. In the app: open the app, tap the round Service button in the middle of the bottom bar and then "Request Service". Choose the problem, write a few words about it, mark it urgent only if there is no water, and send. You get a ticket number straight away (it starts with PMR). Registered AQUIQ engineers near you are alerted; the first to accept is assigned, and you can see the engineer\'s name and expected arrival time in the same card. You can have one open request at a time, and up to 5 requests a day.',
  },
  {
    id: 'track', title: 'Tracking the engineer',
    keywords: ['track', 'where', 'eta', 'arrive', 'how long', 'kab', 'map', 'location', 'reach', 'coming'],
    text: 'As soon as an engineer accepts your request, the Request Service card shows a small map with your site. Once the engineer\'s phone shares its location, the map also shows the engineer, roughly how many minutes away they are, and the distance (an estimate based on distance and city traffic). When they arrive, the card says so, and when the work is marked done the map disappears until your next request.',
  },
  {
    id: 'rules', title: 'Rules AQUIQ engineers follow (SOP)',
    keywords: ['rule', 'rules', 'sop', 'procedure', 'engineer', 'technician', 'cash', 'money', 'payment', 'charge', 'id', 'verified', 'behave', 'allowed', 'policy', 'niyam'],
    text: 'Every AQUIQ engineer is registered and ID-verified. Their rules: they must be at your site before marking arrival (the app checks their location); they photograph the unit before and after the work; they complete a checklist (membrane and filters flushed and checked, no leakage, output TDS tested, pump and power checked, area cleaned and the work shown to you); they never take cash or any payment on AQUIQ\'s behalf unless it is officially recorded; they keep your details private; they are polite and leave the place clean; and they file the service report within 2 hours of finishing. If an engineer breaks the rules, AQUIQ can warn or block them permanently.',
  },
  {
    id: 'approval', title: 'Approving the work',
    keywords: ['approve', 'approval', 'satisfied', 'not satisfied', 'happy', 'complete', 'done', 'confirm', 'sign', 'sahi'],
    text: 'When the engineer finishes, your Request Service card shows "Work done" with two buttons: "Yes, approve the work" and "Not satisfied". If you are not satisfied, tell us what is still wrong; the job reopens, our helpdesk team contacts you first, and then arranges an engineer to come back. If you are not available, the engineer may close the job with a reason, which is recorded on the report.',
  },
  {
    id: 'report', title: 'Service report',
    keywords: ['report', 'pdf', 'document', 'proof', 'receipt', 'download', 'rapat'],
    text: 'After each service the engineer files a service report: the readings from your unit (TDS in and out, flows, pump, membrane), spare parts used, the checklist, the engineer\'s name and designation, and whether you approved it. It carries the AQUIQ logo and letterhead. You can open it any time from the Visit Log with the 📄 icon.',
  },
  {
    id: 'visitlog', title: 'Visit Log, Excel and PDF',
    keywords: ['visit', 'log', 'history', 'excel', 'spreadsheet', 'xlsx', 'download', 'last service', 'previous', 'record', 'list'],
    text: 'Open the Service tab (the round button in the middle of the bottom bar) and tap "Visit Log". Every visit is one line, newest first: the date, ticket, engineer and problem, with a 📄 to open its report. Your own "+ Log" visits are in the same list. At the top, "Download Excel" and "Download PDF" give you the whole log up to this moment, with the AQUIQ logo and letterhead; new visits are included automatically each time you download.',
  },
  {
    id: 'emails', title: 'Emails you receive',
    keywords: ['email', 'mail', 'emails', 'notification', 'notify', 'inform', 'update me', 'inbox', 'get an email', 'get email', 'send email', 'email me', 'mail me', 'by email', 'on email'],
    text: 'AQUIQ emails you at the key moments, to the email your AQUIQ account is registered with: when your request is received (with your ticket number), if the engineer is running late, if you say you are not satisfied and the job is reopened, when you cancel a request, and finally with the service report PDF once you have approved the work. The AQUIQ care team is copied on these emails. When an engineer is assigned and when the work is finished you are told in the app (and by notification) rather than by email. You can follow everything live in the app.',
  },
  {
    id: 'contact', title: 'Changing your email or mobile number',
    keywords: ['change email', 'add email', 'my email', 'email id', 'change mobile', 'change number', 'change phone', 'mobile number', 'update email', 'which email', 'email address', 'contact details', 'profile', 'login with email', 'email login', 'log in with email', 'login'],
    text: 'Stores: open Settings in the app, find "Contact details", tap "Add email" (or "Change email"), type your email and enter the 6-digit code we send to confirm it is yours. Service updates and reports then go to that email. If a store has no email of its own, they go to the company account\'s email. Company accounts: tap the 👤 icon on the home screen to add or change the email, or to change the mobile number (the code goes to your confirmed email). Stores log in with their registered mobile number, or with their confirmed email: tap "Log in with email instead" on the store login screen and enter the 6-digit code sent to that email.',
  },
  {
    id: 'password', title: 'Forgot password',
    keywords: ['forgot password', 'forgot my password', 'reset password', 'new password', 'change password', 'password bhul', 'cannot login', 'cant login', "can't login", 'unable to login', 'login problem'],
    text: 'Company accounts: on the login screen tap "Forgot password?", enter your registered email, then enter the 6-digit code we email you and choose a new password (at least 8 characters, with letters and numbers). Stores log in with their registered mobile number or a confirmed email and a 6-digit code, so they have no password to forget. If you have no email on your account, write to info@prtechno.in or careprtech@hotmail.com and we will help.',
  },
  {
    id: 'rating', title: 'Rating a service',
    keywords: ['rate', 'rating', 'star', 'feedback', 'review'],
    text: 'After a service is finished and the report is filed, a "How was your service?" card appears in the Service tab. Give 1 to 5 stars and an optional comment. One rating per service.',
  },
  {
    id: 'retention', title: 'How long photos and reports are kept',
    keywords: ['delete', 'deleted', 'kept', 'keep', 'store', 'storage', 'retention', 'photos', 'photo', 'video', '12 months', 'year', 'remove', 'how long', 'history kept'],
    text: 'Photos, videos and the report PDF file of a service are kept for 12 months from the date the engineer saves the report, and are then deleted from AQUIQ\'s servers. Your visit log and all the report details stay in your account. After 12 months the report can still be downloaded as a PDF, just without the photos and videos. Please download anything you want to keep with its photos before then. Sensor history is kept on a rolling 6-month basis, and monthly reports are saved permanently.',
  },
  {
    id: 'whatsnew', title: 'Recent updates',
    keywords: ['new', 'update', 'updates', 'feature', 'features', 'changed', 'latest', 'recent', 'added', 'kya naya'],
    text: 'Recent updates to AQUIQ (October 2026): you can now Request Service inside the app and see the status live; you can track your engineer with an arrival time and a map; you can approve the finished work or tell us what is still wrong; every service has a PDF report with the AQUIQ letterhead; the Visit Log shows each visit in one line and can be downloaded as Excel or PDF; you can rate each service from 1 to 5 stars; and you also get an email when your request is received, if the engineer is late, if a job is reopened, and with the final report; and you can cancel a request until the engineer arrives; and a "What\'s new" note appears after every update. Earlier (August 2026): monthly reports in PDF and Excel, predictive maintenance alerts, and Ask AQUIQ.',
  },
  {
    id: 'support', title: 'Contact and support',
    keywords: ['contact', 'support', 'help', 'call', 'email', 'phone', 'number', 'hours', 'timing', 'care'],
    text: 'AQUIQ support: careprtech@hotmail.com or info@prtechno.in. Support hours are Monday to Saturday, 10 AM to 6 PM IST. For an urgent problem with no water, use "Request Service" and mark it urgent.',
  },
  {
    id: 'privacy', title: 'Privacy',
    keywords: ['privacy', 'private', 'data', 'share', 'safe', 'secure', 'personal'],
    text: 'Your data is stored on AQUIQ\'s protected systems and is never sold or shared with third parties. Only authorised AQUIQ staff and your registered account can see your store data. An engineer sees your contact person and phone number only while doing your job; after the work is marked done they can no longer see them.',
  },
];

const stop = new Set(['the', 'a', 'an', 'is', 'are', 'my', 'me', 'i', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'what', 'who', 'how', 'do', 'does', 'can', 'it', 'this', 'that', 'with', 'about']);

// Picks the most relevant section by keyword overlap (used when the AI brain is not connected).
function search(question) {
  const q = String(question || '').toLowerCase();
  const words = q.split(/[^a-z0-9ऀ-ॿ]+/).filter(w => w && !stop.has(w));
  let best = null; let bestScore = 0;
  for (const k of KNOWLEDGE) {
    let score = 0;
    for (const kw of k.keywords) {
      if (kw.includes(' ') ? q.includes(kw) : words.includes(kw)) score += kw.includes(' ') ? 4 : (kw.length > 4 ? 2 : 1);
    }
    if (score > bestScore) { best = k; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

function asPromptText() {
  return KNOWLEDGE.map(k => `## ${k.title}\n${k.text}`).join('\n\n');
}

module.exports = { KNOWLEDGE, search, asPromptText };
