// Admin authentication for the AQUIQ backend.
//
// Staff sign in to the admin panel through Supabase Auth and the panel sends
// their access token with every admin request:  Authorization: Bearer <token>
// We confirm the token with Supabase, then check the person's role. The role is
// stored in Supabase "app_metadata", which users cannot edit themselves.
//
//   owner → everything, including managing team access
//   staff → shown in the panel as "Team (Emp)". An owner decides, per person:
//           state  'active'   → only the rights switched on (PERMS below)
//                  'readonly' → can look at every screen but change nothing
//                  frozen     → cannot sign in at all (the Supabase ban)
//           A Team (Emp) member can add ONE more Team (Emp) member at most (right "add_team"),
//           can never create an owner, and can never remove anyone.
//
// Rollout safety: until ADMIN_AUTH_ENFORCE=true is set on the server, admin
// routes only LOG what they would have blocked and still let the request
// through — so a mistake while setting up accounts cannot lock the team out.
// Owner-only team routes are always enforced; they are new and powerful.

const ROLES = ['owner', 'staff'];

// The rights an owner can switch on for a Team (Emp) person. Everything is OFF by default.
const PERMS = ['add_team', 'tickets_work', 'tickets_cancel', 'engineers_manage', 'accounts_add', 'accounts_remove', 'approvals', 'device_controls', 'mail_settings'];
const STATES = ['active', 'readonly'];

// What does this request need? { open } nobody needs a right | { owner } owner only | { perm } | { denied }
function requirement(method, rawPath, body) {
  const p = String(rawPath || '').split('?')[0].replace(/\/+$/, '') || '/';
  const get = method === 'GET' || method === 'HEAD';
  if (p === '/admin/me') return { open: true };
  if (p === '/admin/team/invite') return { perm: 'add_team' };
  if (p === '/admin/team') return get ? { perm: 'add_team' } : { owner: true };
  if (p.startsWith('/admin/team/') || p.startsWith('/admin/activity')) return { owner: true };
  if (p.startsWith('/admin/mail-status') || p.startsWith('/admin/mail-test')) return { perm: 'mail_settings' };
  if (get) return { open: true };
  if (p.startsWith('/admin/tickets')) return { perm: body && body.action === 'cancel' ? 'tickets_cancel' : 'tickets_work' };
  if (p.startsWith('/admin/service-reports') || p.startsWith('/reports')) return { perm: 'tickets_work' };
  if (p.startsWith('/admin/engineers')) return { perm: 'engineers_manage' };
  if (p.startsWith('/admin/accounts')) return { perm: 'accounts_add' };
  if (p.startsWith('/device') || p.startsWith('/hardware-events')) return { perm: 'device_controls' };
  return { denied: true };          // a change nobody listed: refused for Team (Emp)
}

// Decide for one signed-in person. Owners may do everything.
function authorize(user, method, rawPath, body) {
  if (user.role === 'owner') return { ok: true };
  const need = requirement(method, rawPath, body);
  if (need.open) return { ok: true };
  if (need.owner || need.denied) return { ok: false, code: 'not_available' };
  const get = method === 'GET' || method === 'HEAD';
  if (user.state !== 'active') return { ok: false, code: get ? 'not_available' : 'readonly' };
  if (!user.perms || user.perms[need.perm] !== true) return { ok: false, code: 'not_available' };
  return { ok: true, perm: need.perm };
}

function createAdminAuth(supabase, options = {}) {
  const isEnforcing = options.isEnforcing || (() => process.env.ADMIN_AUTH_ENFORCE === 'true');

  // Returns { user: {id, email, role} } on success, or { error: '<reason>' }.
  async function identify(req) {
    const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return { error: 'missing_token' };

    let result;
    try {
      result = await supabase.auth.getUser(match[1]);
    } catch (err) {
      return { error: 'auth_unavailable' };
    }
    const { data, error } = result;
    if (error || !data?.user) return { error: 'invalid_token' };

    const user = data.user;
    if (user.banned_until && new Date(user.banned_until) > new Date()) return { error: 'disabled' };

    const role = user.app_metadata?.role;
    if (!ROLES.includes(role)) return { error: 'no_role' };

    const meta = user.app_metadata || {};
    const perms = {};
    for (const k of PERMS) perms[k] = !!(meta.perms && meta.perms[k] === true);
    // a Team (Emp) person with no state saved yet is treated as read-only (the safe side)
    const state = role === 'owner' ? 'active' : (STATES.includes(meta.state) ? meta.state : 'readonly');
    return { user: { id: user.id, email: user.email, role, state, perms, added_by: meta.added_by || null, added_by_role: meta.added_by_role || null } };
  }

  // The activity trail: who changed what, and what was refused. Best effort: it never blocks a request.
  const SHOW = ['action', 'role', 'email', 'state', 'disabled', 'customer_id', 'status', 'reason', 'perms'];
  function trail(req, user, outcome, why) {
    if (!options.logActivity) return;
    const detail = {};
    for (const k of SHOW) if (req.body && req.body[k] !== undefined) detail[k] = req.body[k];
    if (why) detail.refused = why;
    const entry = { actor_id: user.id, actor_email: user.email, role: user.role, method: req.method, path: String(req.originalUrl || '').split('?')[0].slice(0, 200), detail };
    if (outcome === 'blocked') { entry.status = 403; Promise.resolve(options.logActivity(entry)).catch(() => {}); return; }
    req.res && req.res.on('finish', () => { entry.status = req.res.statusCode; Promise.resolve(options.logActivity(entry)).catch(() => {}); });
  }

  const STATUS = { missing_token: 401, invalid_token: 401, disabled: 403, no_role: 403, forbidden: 403, readonly: 403, not_available: 403, auth_unavailable: 503 };
  const MESSAGE = {
    missing_token: 'Sign in required.',
    invalid_token: 'Your session is not valid. Sign in again.',
    disabled: 'This account is frozen by the owner.',
    no_role: 'This account has not been given access.',
    forbidden: 'Your role is not allowed to do this.',
    readonly: 'This account has read-only access.',
    not_available: 'This is not available for your account.',
    auth_unavailable: 'Could not verify your session right now. Try again.',
  };

  function guard(allowedRoles, { alwaysEnforce = false, guardsRights = false } = {}) {
    return async (req, res, next) => {
      const result = await identify(req);
      let reason = result.error;
      if (result.user) {
        req.admin = result.user;
        if (allowedRoles.includes(result.user.role)) {
          // The Team (Emp) rights are ALWAYS enforced (they are new); the old role check below keeps its log-only rollout switch.
          const call = authorize(result.user, req.method, req.originalUrl, req.body);
          if (call.ok || !guardsRights) {
            if (req.method !== 'GET' && req.method !== 'HEAD') trail(req, result.user, call.ok ? null : 'blocked');
            return next();
          }
          trail(req, result.user, 'blocked', call.code);
          console.warn(`[AUTH] blocked ${req.method} ${req.originalUrl} — ${call.code} (${result.user.email})`);
          return res.status(403).json({ error: MESSAGE[call.code], code: call.code });
        }
        reason = 'forbidden';
      }

      if (!alwaysEnforce && !isEnforcing()) {
        console.warn(`[AUTH] (log-only) would block ${req.method} ${req.originalUrl} — ${reason}`);
        return next();
      }
      console.warn(`[AUTH] blocked ${req.method} ${req.originalUrl} — ${reason}`);
      return res.status(STATUS[reason] || 403).json({ error: MESSAGE[reason] || 'Not allowed.', code: reason });
    };
  }

  return {
    identify,
    requireStaff: guard(['owner', 'staff'], { guardsRights: true }),
    requireOwner: guard(['owner'], { alwaysEnforce: true }),
  };
}

module.exports = { createAdminAuth, ROLES, PERMS, STATES, authorize, requirement };
