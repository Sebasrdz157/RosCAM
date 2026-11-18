// RosCAM's data (sheet inventory, tool library) lives in the Parts Tracker's Firestore, behind
// its /api/roscam/ endpoints, and every call is signed with the user's Auth0 login: the same
// login, settings and /auth0.js library as the Parts Tracker board. Exposes window.RosDB.
//
// Anyone signed in can read; changing anything takes the Parts Tracker admin or Assignee
// role (the server checks; canEdit() only greys out buttons).
'use strict';

(function () {
  const cfg = window.ROSCAM_CONFIG;
  const API = `${cfg.apiBase}/api/roscam`;
  const listeners = new Set();
  let client = null;
  let me = null;            // {email, name, picture, can_edit} once signed in

  function changed() { listeners.forEach((fn) => fn(user())); }
  function user() { return me ? { email: me.email, name: me.name, picture: me.picture } : null; }

  async function auth0Client() {
    if (client) return client;
    if (!window.auth0 || !window.auth0.createAuth0Client) {
      throw new Error('The sign-in library did not load. Reload the page.');
    }
    client = await window.auth0.createAuth0Client({
      domain: cfg.auth0Domain,
      clientId: cfg.auth0ClientId,
      authorizationParams: { audience: cfg.auth0Audience, scope: 'openid email profile' },
      useRefreshTokens: true,
      cacheLocation: 'localstorage',
    });
    return client;
  }

  async function token() {
    const c = await auth0Client();
    return c.getTokenSilently({ authorizationParams: { audience: cfg.auth0Audience } });
  }

  async function loadMe() {
    me = await request('GET', '/me');
    changed();
    return user();
  }

  // Restore an existing sign-in without a popup. Resolves to the user, or null if not signed in.
  async function restore() {
    try {
      await token();
      return await loadMe();
    } catch (_) {
      me = null;
      changed();
      return null;
    }
  }

  async function signIn() {
    const c = await auth0Client();
    await c.loginWithPopup();
    return loadMe();
  }

  async function signOut() {
    const c = await auth0Client();
    me = null;
    changed();
    await c.logout({ logoutParams: { returnTo: window.location.href } });
  }

  async function request(method, path, body) {
    let t;
    try {
      t = await token();
    } catch (_) {
      me = null;
      changed();
      throw new Error('Sign in with your team account first.');
    }
    const headers = { Authorization: `Bearer ${t}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) throw new Error('Your sign-in expired. Sign in again.');
      throw new Error(text || `Request failed (${res.status})`);
    }
    return text ? JSON.parse(text) : null;
  }

  const enc = encodeURIComponent;
  window.RosDB = {
    user, restore, signIn, signOut,
    canEdit: () => !!(me && me.can_edit),
    onAuthChange(fn) { listeners.add(fn); },
    listSheets: () => request('GET', '/sheets'),
    addSheet: (sheet) => request('POST', '/sheets', sheet),
    updateSheet: (id, patch) => request('PATCH', `/sheets/${enc(id)}`, patch),
    deleteSheet: (id) => request('DELETE', `/sheets/${enc(id)}`),
    addRegion: (region) => request('POST', '/regions', region),
    deleteRegion: (id) => request('DELETE', `/regions/${enc(id)}`),
    listTools: () => request('GET', '/tools'),
    addTool: (tool) => request('POST', '/tools', tool),
    // Bits belong to a machine (the same ID can exist on two machines), so say which one.
    updateTool: (id, patch) => request('PATCH', `/tools/${enc(id)}?machine=${enc(patch.machine || 'shop')}`, patch),
    deleteTool: (id, machine) => request('DELETE', `/tools/${enc(id)}?machine=${enc(machine || 'shop')}`),
  };
})();
