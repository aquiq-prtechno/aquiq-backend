'use strict';
// Rules the engineer app follows in the field. Kept in one place so the server and the app agree.

const ARRIVAL_RADIUS_M = 500;          // "Arrived" only counts within this distance of the site
const SOP_VERSION = 'v1';              // bump this to make every engineer read and accept the SOPs again

const CHECKLIST = [
  { key: 'flushed', en: 'Membrane and filters flushed and checked', hi: 'मेम्ब्रेन और फ़िल्टर फ्लश करके चेक किए' },
  { key: 'leaks', en: 'No leakage anywhere', hi: 'कहीं भी लीकेज नहीं है' },
  { key: 'tds', en: 'Output water TDS tested', hi: 'आउटपुट पानी का TDS टेस्ट किया' },
  { key: 'pump', en: 'Pump and power supply checked', hi: 'पंप और पावर सप्लाई चेक की' },
  { key: 'clean', en: 'Area cleaned and the work shown to the customer', hi: 'जगह साफ़ की और ग्राहक को काम दिखाया' },
];

const PARTS = [
  'Sediment filter', 'Carbon filter', 'RO membrane', 'Pump', 'Solenoid valve', 'SMPS / adaptor',
  'TDS sensor', 'Flow sensor', 'Pressure switch', 'Tank', 'Tubing / fittings', 'Other',
];

const NO_GPS_REASONS = [
  { key: 'gps_off', en: 'My phone location is not working', hi: 'मेरे फ़ोन की लोकेशन काम नहीं कर रही' },
  { key: 'map_wrong', en: 'The site position on the map is wrong', hi: 'मैप पर साइट की लोकेशन गलत है' },
  { key: 'other', en: 'Other reason', hi: 'दूसरा कारण' },
];

module.exports = { ARRIVAL_RADIUS_M, SOP_VERSION, CHECKLIST, PARTS, NO_GPS_REASONS };
