// Stand-ins for what the Parts Tracker gives RosCAM, for the browser tests:
//  - /auth0.js: a fake Auth0 client (signed in when localStorage 'fake.auth0' is '1';
//    "Sign in" sets it, as the real popup would),
//  - /api/roscam/*: an in-memory copy of the API in PartsTracker src/routes/roscam.rs, with the
//    same rules: every call needs the token, changes need the editor role (admin or Assignee).
//
//   const parts = await fakeParts(context, { db, tools, signedIn: true, canEdit: true });
//   parts.user.canEdit = false;   // later calls answer as a view-only user
'use strict';

const FAKE_AUTH0 = `
window.auth0 = {
  async createAuth0Client() {
    const signed = () => localStorage.getItem('fake.auth0') === '1';
    return {
      async getTokenSilently() { if (!signed()) throw new Error('Login required'); return 'fake-token'; },
      async loginWithPopup() { localStorage.setItem('fake.auth0', '1'); },
      async logout() { localStorage.removeItem('fake.auth0'); location.reload(); },
    };
  },
};`;

async function fakeParts(context, { db = { sheets: [], regions: [] }, tools = [], signedIn = true, canEdit = true,
                                    email = 'maker@frc5572.org', name = 'Test Maker' } = {}) {
  const user = { canEdit, email, name };
  let next = 1;
  const now = () => new Date(Date.now() + next).toISOString();
  if (signedIn) await context.addInitScript(() => localStorage.setItem('fake.auth0', '1'));
  await context.route('**/auth0.js', (r) => r.fulfill({ body: FAKE_AUTH0, contentType: 'text/javascript' }));

  await context.route('**/api/roscam/**', (route) => {
    const req = route.request(), method = req.method();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\/roscam/, '');
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const reply = (status, data) => route.fulfill({
      status, contentType: typeof data === 'string' ? 'text/plain' : 'application/json',
      body: data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data),
    });
    if (req.headers().authorization !== 'Bearer fake-token') return reply(401, 'Unauthorized');
    if (method === 'GET' && path === '/me') return reply(200, { email, name, picture: '', can_edit: user.canEdit });
    if (method === 'GET' && path === '/sheets') {
      return reply(200, db.sheets.map((s) => ({ ...s, sheet_regions: db.regions.filter((r) => r.sheet_id === s.id) })));
    }
    if (method === 'GET' && path === '/tools') return reply(200, tools);
    if (!user.canEdit) {
      return reply(403, "Your account can't change RosCAM data. Ask a Parts Tracker admin to give you the Assignee role.");
    }
    let m;
    if (method === 'POST' && path === '/sheets') {
      if (db.sheets.some((s) => s.id === body.id)) return reply(409, 'A sheet with that ID already exists.');
      const row = { status: 'active', notes: '', width: 24, height: 48, ...body, created_at: now(), created_by: email };
      db.sheets.push(row);
      return reply(201, { ...row, sheet_regions: [] });
    }
    if ((m = path.match(/^\/sheets\/(.+)$/))) {
      const id = decodeURIComponent(m[1]);
      const s = db.sheets.find((x) => x.id === id);
      if (!s) return reply(404, 'That sheet no longer exists.');
      if (method === 'PATCH') {
        if (body.status !== undefined) s.status = body.status;
        if (body.notes !== undefined) s.notes = body.notes;
        return reply(200, { ...s, sheet_regions: db.regions.filter((r) => r.sheet_id === id) });
      }
      if (method === 'DELETE') {
        db.sheets.splice(db.sheets.indexOf(s), 1);
        for (let i = db.regions.length - 1; i >= 0; i--) if (db.regions[i].sheet_id === id) db.regions.splice(i, 1);
        return reply(204);
      }
    }
    if (method === 'POST' && path === '/regions') {
      if (!db.sheets.some((s) => s.id === body.sheet_id)) return reply(404, 'That sheet no longer exists.');
      const row = { id: `r${next++}`, label: '', ...body, created_at: now(), created_by: email };
      db.regions.push(row);
      return reply(201, row);
    }
    if (method === 'DELETE' && (m = path.match(/^\/regions\/(.+)$/))) {
      const i = db.regions.findIndex((r) => r.id === decodeURIComponent(m[1]));
      if (i < 0) return reply(404, 'That area no longer exists.');
      db.regions.splice(i, 1);
      return reply(204);
    }
    if (method === 'POST' && path === '/tools') {
      if (tools.some((t) => t.id === body.id)) return reply(409, 'A bit with that ID already exists.');
      const row = { ...body, created_at: now(), created_by: email };
      tools.push(row);
      return reply(201, row);
    }
    if ((m = path.match(/^\/tools\/(.+)$/))) {
      const i = tools.findIndex((t) => t.id === decodeURIComponent(m[1]));
      if (i < 0) return reply(404, 'That bit no longer exists.');
      if (method === 'PATCH') { Object.assign(tools[i], body); return reply(200, tools[i]); }
      if (method === 'DELETE') { tools.splice(i, 1); return reply(204); }
    }
    return reply(400, `unhandled ${method} ${path}`);
  });
  return { db, tools, user };
}

module.exports = { fakeParts };
