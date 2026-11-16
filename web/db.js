// Tiny Supabase client for the sheet inventory: email/password sign-in and the two tables,
// over Supabase's REST API (no library needed). Exposes window.RosDB.
'use strict';

(function () {
  const cfg = window.ROSCAM_CONFIG;
  const SESSION_KEY = 'roscam.session';
  let session = loadSession();
  const listeners = new Set();

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }
  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) { /* storage blocked: stays signed in for this visit only */ }
    listeners.forEach((fn) => fn(user()));
  }
  function user() { return session ? { email: session.email } : null; }

  async function authRequest(path, body) {
    const res = await fetch(`${cfg.supabaseUrl}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.msg || data.message || `Sign-in failed (${res.status})`);
    return {
      access_token: data.access_token, refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      email: (data.user && data.user.email) || body.email || (session && session.email),
    };
  }

  async function signIn(email, password) {
    saveSession(await authRequest('token?grant_type=password', { email, password }));
    return user();
  }

  async function signOut() {
    const s = session;
    saveSession(null);
    if (s) {
      fetch(`${cfg.supabaseUrl}/auth/v1/logout`, {
        method: 'POST', headers: { apikey: cfg.supabaseKey, Authorization: `Bearer ${s.access_token}` },
      }).catch(() => {});
    }
  }

  async function token() {
    if (!session) return null;
    if (Date.now() > session.expires_at - 60000) {
      try {
        saveSession(await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token }));
      } catch (_) {
        saveSession(null);
        return null;
      }
    }
    return session.access_token;
  }

  async function rest(method, path, body) {
    const headers = { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' };
    const t = await token();
    if (t) headers.Authorization = `Bearer ${t}`;
    if (method !== 'GET') headers.Prefer = 'return=representation';
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = (data && (data.message || data.hint)) || `Request failed (${res.status})`;
      if (res.status === 401 || res.status === 403 || (data && data.code === '42501')) {
        if (!cfg.requireSignIn && !t) {
          throw new Error('The database is locked to signed-in editors. Re-run supabase/schema.sql in Supabase to open editing.');
        }
        throw new Error(t ? 'This account is not allowed to change sheets. Ask an admin to add it to the editors list.'
                          : 'Sign in with the team account to change sheets.');
      }
      if (res.status === 404 && /sheets|sheet_regions|tools/.test(msg)) {
        throw new Error(`The ${/tools/.test(msg) ? 'tool library' : 'sheet'} table is missing. Run supabase/schema.sql in the Supabase SQL editor.`);
      }
      if (data && data.code === '23505') throw new Error(path.startsWith('tools') ? 'A bit with that ID already exists.' : 'A sheet with that ID already exists.');
      if (data && data.code === '23514') throw new Error(`The database rejected a value: ${msg}`);
      throw new Error(msg);
    }
    // Row rules hide rows a user may not change, so a refused update/delete "succeeds"
    // with nothing changed. Treat that as the error it is.
    if ((method === 'PATCH' || method === 'DELETE') && Array.isArray(data) && data.length === 0) {
      throw new Error(t || !cfg.requireSignIn
        ? 'Nothing was changed: the item no longer exists, or the database only lets editors change it.'
        : 'Sign in with the team account to change sheets.');
    }
    return data;
  }

  const enc = encodeURIComponent;
  window.RosDB = {
    user, signIn, signOut,
    onAuthChange(fn) { listeners.add(fn); },
    listSheets: () => rest('GET', 'sheets?select=*,sheet_regions(*)&order=id.asc'),
    addSheet: (sheet) => rest('POST', 'sheets', sheet).then((r) => r[0]),
    updateSheet: (id, patch) => rest('PATCH', `sheets?id=eq.${enc(id)}`, patch).then((r) => r[0]),
    deleteSheet: (id) => rest('DELETE', `sheets?id=eq.${enc(id)}`),
    addRegion: (region) => rest('POST', 'sheet_regions', region).then((r) => r[0]),
    deleteRegion: (id) => rest('DELETE', `sheet_regions?id=eq.${enc(id)}`),
    listTools: () => rest('GET', 'tools?select=*&order=type.asc,diameter.desc'),
    addTool: (tool) => rest('POST', 'tools', tool).then((r) => r[0]),
    updateTool: (id, patch) => rest('PATCH', `tools?id=eq.${enc(id)}`, patch).then((r) => r[0]),
    deleteTool: (id) => rest('DELETE', `tools?id=eq.${enc(id)}`),
  };
})();
