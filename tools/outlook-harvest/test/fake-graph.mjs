// Preload for end-to-end tests: replaces fetch with an in-memory Microsoft identity platform +
// Graph so the real CLI runs with no network. FAKE_SCOPE overrides the granted scope string.
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
export const MESSAGES = {
  'AAMkAD+one/1==': Buffer.from('From: a@example.com\r\nSubject: one\r\n\r\nhello\r\n'),
  'AAMkAD+two/2==': Buffer.concat([Buffer.from('Subject: two\r\n\r\n'), Buffer.from([0x00, 0xff, 0x80])]),
  'AAMkAD+three/3=': Buffer.from('Subject: three\r\n\r\n' + 'x'.repeat(3000) + '\r\n'),
};
export const GONE = 'AAMkAD+gone/9==';
let polls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const method = init.method ?? 'GET';
  if (u.hostname === 'login.microsoftonline.com') {
    if (method !== 'POST') return json(599, { error: 'unexpected method' });
    const form = new URLSearchParams(String(init.body));
    if (u.pathname.endsWith('/devicecode')) {
      if (!/Mail\.Read/.test(form.get('scope')) || /ReadWrite|Send/.test(form.get('scope'))) return json(599, { error: 'bad requested scope' });
      return json(200, { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 60, interval: 0, message: 'To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code ABCD-EFGH.' });
    }
    if (u.pathname.endsWith('/token')) {
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        const n = polls++;
        if (n === 0) return json(400, { error: 'authorization_pending' });
        if (n === 1 && process.env.FAKE_DROP) throw new TypeError('fetch failed'); // a dropped connection mid-wait
      }
      return json(200, { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, scope: process.env.FAKE_SCOPE ?? 'https://graph.microsoft.com/Mail.Read openid profile', id_token: jwt({ preferred_username: 'Me@Example.com' }) });
    }
  }
  if (u.hostname === 'graph.microsoft.com') {
    if (method !== 'GET') return json(599, { error: { message: `fake graph: unexpected ${method}` } });
    if (init.headers?.Authorization !== 'Bearer fake-access') return json(401, { error: { message: 'bad token' } });
    const p = decodeURIComponent(u.pathname.replace('/v1.0/me', ''));
    if (p === '/mailFolders') return json(200, { value: [{ id: 'F1', displayName: 'Inbox', totalItemCount: 3, unreadItemCount: 1 }, { id: 'F2', displayName: 'Junk Email', totalItemCount: 1, unreadItemCount: 1 }] });
    const all = [...Object.keys(MESSAGES), GONE].map((id, i) => ({ id, conversationId: `c${i}`, receivedDateTime: `2026-09-2${i}T10:00:00Z`, parentFolderId: i === 3 ? 'F2' : 'F1', webLink: `https://outlook.live.com/owa/?ItemID=${i}` }));
    if (p === '/messages' && !u.searchParams.get('skip')) return json(200, { value: all.slice(0, 2), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?skip=2' });
    if (p === '/messages' && u.searchParams.get('skip') === '2') return json(200, { value: all.slice(2) });
    const m = /^\/messages\/(.+)\/\$value$/.exec(p);
    if (m) return m[1] === GONE ? json(404, { error: { message: 'not found' } }) : new Response(MESSAGES[m[1]], { status: 200 });
    return json(404, { error: { message: `fake graph: no route ${p}` } });
  }
  return json(599, { error: `fake: unexpected host ${u.hostname}` });
};
