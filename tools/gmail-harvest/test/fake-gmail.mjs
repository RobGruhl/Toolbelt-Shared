// Preload for the export end-to-end test: replaces fetch with an in-memory Gmail so the real CLI
// runs with no network. Only GETs are served; anything else fails the test loudly.
// Messages: three exportable ids and one that answers 404.
const MESSAGES = {
  '18f0000000000001': Buffer.from('From: a@example.com\r\nSubject: one\r\n\r\nhello\r\n'),
  '18f0000000000002': Buffer.concat([Buffer.from('Subject: two\r\n\r\n'), Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a])]),
  '18f0000000000003': Buffer.from('Subject: three\r\n\r\n' + 'x'.repeat(5000) + '\r\n'),
};
const GONE = '18f00000000000ff';

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if ((init.method ?? 'GET') !== 'GET') return json(599, { error: { message: `fake gmail: unexpected ${init.method} ${u.pathname}` } });
  if (!/^Bearer fake-access$/.test(init.headers?.Authorization ?? '')) return json(401, { error: { message: 'bad token' } });
  const p = u.pathname.replace('/gmail/v1/users/me', '');
  if (p === '/profile') return json(200, { emailAddress: 'me@example.com', messagesTotal: 4, threadsTotal: 4, historyId: '1' });
  if (p === '/messages') {
    const ids = [...Object.keys(MESSAGES), GONE].slice(0, Number(u.searchParams.get('maxResults')));
    return json(200, { messages: ids.map((id) => ({ id, threadId: `t${id}` })), resultSizeEstimate: 4 });
  }
  const m = /^\/messages\/([0-9a-f]+)$/.exec(p);
  if (m && u.searchParams.get('format') === 'raw') {
    if (m[1] === GONE) return json(404, { error: { code: 404, message: 'Requested entity was not found.' } });
    const buf = MESSAGES[m[1]];
    return json(200, { id: m[1], threadId: `t${m[1]}`, labelIds: ['INBOX'], internalDate: '1758585600000', sizeEstimate: buf.length, historyId: '9', raw: buf.toString('base64url'), snippet: 'never stored' });
  }
  return json(404, { error: { message: `fake gmail: no route ${p}` } });
};
export { MESSAGES, GONE };
