// Optional Keycloak OIDC middleware. When KEYCLOAK_URL is set, every /api/*
// request must carry a valid Bearer token. In dev (no Keycloak), middleware
// is a no-op and requests are anonymous.

const useAuth = !!process.env.KEYCLOAK_URL;
let _verifier = null;

function init() {
  if (!useAuth) return;
  // Lazy-loaded
  const jose = require('jose');
  const issuer = `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM || 'halford'}`;
  const jwks = jose.createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
  _verifier = async (token) => jose.jwtVerify(token, jwks, { issuer });
}

function middleware() {
  if (!useAuth) return (req, res, next) => next();
  init();
  return async (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ error: 'missing bearer token' });
    try {
      const { payload } = await _verifier(m[1]);
      req.user = { sub: payload.sub, email: payload.email, roles: payload.realm_access?.roles || [] };
      next();
    } catch (e) {
      return res.status(401).json({ error: 'invalid token: ' + e.message });
    }
  };
}

module.exports = { useAuth, middleware };
