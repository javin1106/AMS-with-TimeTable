/**
 * Reads the platform JWT from a request.
 *
 * Login issues the same token twice: as the httpOnly `jwt` cookie and in the
 * response body, which the client keeps in localStorage and sends back as
 * `Authorization: Bearer` (see client/src/main.jsx). Only the cookie used to be
 * accepted, which broke every private/incognito window on the deployed site:
 * the cookie is set `SameSite=None`, so browsers that block third-party cookies
 * — the default in private browsing — drop it, and the session appeared to
 * vanish the moment the user finished logging in.
 *
 * The cookie is preferred when present: it is httpOnly, so it cannot be read by
 * script, and it is what a browser sends on its own.
 */
function readAuthToken(req) {
  if (req.cookies?.jwt) return req.cookies.jwt;
  const header = req.get ? req.get("Authorization") : req.headers?.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

module.exports = readAuthToken;
