'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { wrapHtml, simpleHtml } = require('../mailLayout');
const R = require('../reports');

test('every email is wrapped in the AQUIQ layout, the words stay the same', () => {
  const w = wrapHtml('<p>Hello</p>');
  assert.match(w, /email-logo\.png/); assert.match(w, /by PR SONS/); assert.match(w, /text-align:center/); assert.match(w, /Calibri/); assert.match(w, /<p>Hello<\/p>/);
  assert.match(simpleHtml(['one', 'two']), /<p style="text-align:center;margin:0 0 14px">one<\/p>/);
  const m = R.buildReportMail({ ticket_no: 'PMR1', contact_person: 'Amit', issue_category: 'Leak' }, {});
  assert.match(m.html, /email-logo\.png/); assert.match(m.html, /<p style="text-align:left;margin:0 0 22px">Your service\/complaint\/installation/); assert.match(m.html, /STATUS : SOLVED\/CLOSED/); assert.match(m.subject, /^REF\/TIC CLOSED : FSR-PMR1/);
});
