// Admin authentication for the AQUIQ backend.
//
// Staff sign in to the admin panel through Supabase Auth and the panel sends
// their access token with every admin request:  Authorization: Bearer <token>
// We confirm the token with Supabase, then check the person's role. The role is
// stored in Supabase "app_metadata", which users cannot edit themselves.
//
//   owner → everything, including managing team access
//   staff → all admin actions, but not team management
//
// Rollout safety: until ADMIN_AUTH_ENFORCE=true is set on the server, admin
// routes only LOG what they would have blocked and still let the request
// through — so a mistake while setting up accounts cannot lock the team out.
// Owner-only team routes are always enforced; they are new and powerful.

const ROLES = ['owner', 'staff'];

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

    return { user: { id: user.id, email: user.email, role } };
  }

  const STATUS = { missing_token: 401, invalid_token: 401, disabled: 403, no_role: 403, forbidden: 403, auth_unavailable: 503 };
  const MESSAGE = {
    missing_token: 'Sign in required.',
    invalid_token: 'Your session is not valid. Sign in again.',
    disabled: 'This account has been switched off.',
    no_role: 'This account has not been given access.',
    forbidden: 'Your role is not allowed to do this.',
    auth_unavailable: 'Could not verify your session right now. Try again.',
  };

  function guard(allowedRoles, { alwaysEnforce = false } = {}) {
    return async (req, res, next) => {
      const result = await identify(req);
      let reason = result.error;
      if (result.user) {
        req.admin = result.user;
        if (allowedRoles.includes(result.user.role)) return next();
        reason = 'forbidden';
      }

      if (!alwaysEnforce && !isEnforcing()) {
        console.warn(`[AUTH] (log-only) would block ${req.method} ${req.originalUrl} — ${reason}`);
        return next();
      }
      console.warn(`[AUTH] blocked ${req.method} ${req.originalUrl} — ${reason}`);
      return res.status(STATUS[reason] || 403).json({ error: MESSAGE[reason] || 'Not allowed.' });
    };
  }

  return {
    identify,
    requireStaff: guard(['owner', 'staff']),
    requireOwner: guard(['owner'], { alwaysEnforce: true }),
  };
}

module.exports = { createAdminAuth, ROLES };
