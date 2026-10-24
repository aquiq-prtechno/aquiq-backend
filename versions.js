'use strict';
// The newest release of each app. Bump the matching line with every update (see CHANGELOG.md),
// so the admin panel can show who is still running an older version.
const LATEST = { customer: '1.8.1', engineer: '1.2.1', admin: '1.5.1' };

const parts = (v) => String(v || '').split('.').map(n => parseInt(n, 10) || 0);

// -1 = a is older than b, 0 = same, 1 = newer
function compare(a, b) {
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1; }
  return 0;
}

const isOld = (version, app) => !!version && compare(version, LATEST[app]) < 0;

module.exports = { LATEST, compare, isOld };
