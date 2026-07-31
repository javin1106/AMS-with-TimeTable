/**
 * App-wide guard rails on the HTTP surface.
 *
 * Unlike learningModuleRouteGuards, which pins one module in detail, this file
 * asks three blunt questions of the *whole* router:
 *
 *   - are the removed modules actually gone, or did a mount survive?
 *   - can anyone still PUT into the timetable, or POST into attendance,
 *     without a role?
 *   - has a new unauthenticated write appeared anywhere?
 *
 * That last one is the valuable one. An endpoint added without a guard is
 * invisible in review — the handler works, it just answers everybody — and it
 * stays invisible until someone goes looking. Here it fails a test instead.
 */

function mountPath(layer) {
  const keys = layer.keys || [];
  let i = 0;
  return (layer.regexp?.source || '')
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\?\/\|\$\)$/, '')
    .replace(/\(\?:\\?\/\(\[\^[/\\]+\]\+\?\)\)/g, () => `/:${keys[i++]?.name ?? 'p'}`)
    .replace(/\\\//g, '/')
    .replace(/\$$/, '')
    .replace(/\\\./g, '.');
}

/**
 * Flattens the router into `{ endpoint, middleware[] }`.
 *
 * Middleware registered with `router.use(fn)` applies to everything after it,
 * and `router.use('/path', fn)` only to that subtree — both have to be tracked
 * or the answer is wrong in opposite directions.
 */
function collectRoutes(router, prefix = '', inherited = []) {
  const rows = [];
  const scoped = [];

  (router.stack || []).forEach((layer) => {
    if (layer.route) {
      const full = prefix + layer.route.path;
      const applies = scoped.filter((m) => m.at === '' || full.startsWith(prefix + m.at)).map((m) => m.name);
      const names = layer.route.stack.map((e) => e.name || '<anon>');
      Object.keys(layer.route.methods).forEach((method) => {
        rows.push({ ep: `${method.toUpperCase()} ${full}`, mw: [...inherited, ...applies, ...names] });
      });
      return;
    }

    const at = mountPath(layer) === '/' ? '' : mountPath(layer);
    if (layer.handle?.stack) {
      const applies = scoped.filter((m) => m.at === '' || at.startsWith(m.at)).map((m) => m.name);
      rows.push(...collectRoutes(layer.handle, prefix + at, [...inherited, ...applies]));
      return;
    }
    scoped.push({ at, name: layer.name || '<anon>' });
  });

  return rows;
}

const routes = collectRoutes(require('../../src/routes'));

/**
 * Middleware that establishes who the caller is.
 *
 * `<anonymous>` counts because `checkRole(...)` returns an unnamed closure and
 * is the platform's most common guard; it only ever appears before the handler,
 * which is the last entry and is excluded below.
 */
const AUTH = new Set([
  'authenticate', 'authenticateOptional', 'protectRoute', 'verifyToken',
  'facultyRoute', 'studentRoute', 'superadminRoute', 'ttadminRoute',
  'requireTeacher', 'requireOwner', 'requireClassCreator',
  'resolveAttendanceAccess', 'requireAttendanceWriteAccess',
  'bulkUploadAccess', 'quizBelongsToUser', 'ipAllowlist', 'verifyErpSignature', 'dupliCheck',
  '<anonymous>',
]);

const isOpen = (row) => !row.mw.slice(0, -1).some((name) => AUTH.has(name));
const open = routes.filter(isOpen).map((row) => row.ep);

describe('API surface — removed modules', () => {
  it('no longer mounts the review module', () => {
    expect(routes.filter((r) => r.ep.includes('/reviewmodule'))).toEqual([]);
  });

  it('no longer mounts the diabetics module', () => {
    expect(routes.filter((r) => /\/diabetics/i.test(r.ep))).toEqual([]);
  });
});

describe('API surface — timetable writes', () => {
  it('lets nobody PUT into the timetable module without a role', () => {
    // Two of these were reachable with no credentials at all: PUT /subject/:id
    // could rewrite any subject, and the deletefirstyearfaculty PUT could
    // unassign any faculty member.
    const openPuts = open.filter((ep) => ep.startsWith('PUT ') && ep.includes('/timetablemodule'));
    expect(openPuts).toEqual([]);
  });

  it('covers every timetable PUT, not just the ones that existed today', () => {
    // The guard is registered on the module router rather than per route, so a
    // PUT added tomorrow inherits it. If someone re-registers it per route this
    // count assertion is what notices.
    const puts = routes.filter((r) => r.ep.startsWith('PUT ') && r.ep.includes('/timetablemodule'));
    expect(puts.length).toBeGreaterThan(0);
    puts.forEach((row) => {
      expect(row.mw).toContain('<anonymous>');
    });
  });
});

describe('API surface — attendance writes', () => {
  it('lets nobody POST into the attendance module without a role', () => {
    // /liveness-rejected accepted base64 face crops from anyone who could reach
    // the server.
    const openPosts = open.filter((ep) => ep.startsWith('POST ') && ep.includes('/attendancemodule'));
    expect(openPosts).toEqual([]);
  });

  it('guards the ML service upload with the shared service key', () => {
    // Machine callers authenticate by X-ML-Service-Key, the same way
    // attendanceReportRoutes' POST /save does — not by a user role, because
    // there is no user behind them. This one endpoint was left open on the
    // reasoning that only the ML service knows the path.
    const row = routes.find((r) => r.ep === 'POST /attendancemodule/liveness-rejected');
    expect(row).toBeDefined();
    expect(row.mw).toContain('requireAttendanceWriteAccess');
  });

  it('leaves the ERP inbound push on its own signature check', () => {
    // Stronger than a role, not weaker: HMAC signature plus IP allowlist plus
    // rate limiting. Putting checkRole in front would break it for no gain.
    // Matched exactly, not by prefix: /erp-sync and /erp-push are ordinary
    // staff endpoints that happen to share the first four characters.
    const row = routes.find((r) => r.ep === 'POST /attendancemodule/erp/faculty-override-sync');
    expect(row).toBeDefined();
    expect(row.mw).toContain('verifyErpSignature');
    expect(row.mw).toContain('ipAllowlist');
  });
});

/**
 * Writes that are meant to be reachable without a session.
 *
 * Each one is public because it has to be — you cannot require a login on the
 * endpoint that issues the login. Adding to this list should be a conscious act
 * with a reason attached.
 */
const PUBLIC_WRITES = {
  'POST /auth/login': 'issues the session',
  'POST /auth/verify': 'part of the login handshake',
  'POST /auth/otp': 'sent before the user has a session',
  'POST /auth/forgot-password': 'by definition unauthenticated',
  'POST /auth/reset-password': 'authenticated by the emailed token, not a session',
  'POST /conferencemodule/contactUs/': 'public enquiry form on the conference site',
};

describe('API surface — unauthenticated writes', () => {
  it('has no unauthenticated write outside the documented public set', () => {
    const openWrites = open.filter((ep) => !ep.startsWith('GET '));
    const undocumented = openWrites.filter((ep) => !PUBLIC_WRITES[ep]);
    expect(undocumented).toEqual([]);
  });

  it('keeps the public set from quietly growing stale', () => {
    // A public write that no longer exists should be dropped from the list
    // rather than left implying an endpoint is deliberately open.
    const all = new Set(routes.map((r) => r.ep));
    Object.keys(PUBLIC_WRITES).forEach((ep) => expect(all.has(ep)).toBe(true));
  });
});
