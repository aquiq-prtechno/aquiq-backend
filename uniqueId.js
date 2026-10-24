'use strict';
// The "Unique ID (WI)" is the device's WiFi ID (51916-AQ-PR-78:3B:01) under the name staff see.
// Service engineers and the service report see it compact (no hyphens or colons): 51916AQPR783B01,
// and only while the device is powered on (it sent data in the last 5 minutes). The admin panel shows the raw value always.

const ONLINE_MS = 5 * 60 * 1000;

function compact(wifiId) {
  const s = String(wifiId || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s || null;
}

function poweredOn(customer, at = new Date()) {
  if (!customer || !customer.last_seen) return false;
  const seen = new Date(customer.last_seen).getTime();
  return Number.isFinite(seen) && at.getTime() - seen <= ONLINE_MS;
}

// null when the store has no AQUIQ device ID yet, or the device is not powered on now
function forStaff(customer, at = new Date()) {
  if (!customer || !customer.wifi_device_id) return null;
  return poweredOn(customer, at) ? compact(customer.wifi_device_id) : null;
}

module.exports = { compact, poweredOn, forStaff, ONLINE_MS };
