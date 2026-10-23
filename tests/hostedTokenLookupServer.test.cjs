const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { createHostedTokenLookupServer, parseHostedLookupPort } = require('../dist/hosted/tokenLookupServer.js');
const env = { TA_LOOKUP_USERNAME: 'offline', TA_LOOKUP_PASSWORD: 'synthetic-password-only-123456789012', TA_LOOKUP_ORIGIN: 'https://pilot.example' };
const auth = 'Basic ' + Buffer.from(`${env.TA_LOOKUP_USERNAME}:${env.TA_LOOKUP_PASSWORD}`).toString('base64');
const MINT = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const input = JSON.stringify({ chain: 'solana', assetAddress: MINT });
function fixture() {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('dexscreener')) return new Response('[]');
    const body = JSON.parse(options.body);
    let result;
    if (body.method === 'getAccountInfo') {
      const data = Buffer.alloc(82); data.writeBigUInt64LE(1000n, 36); data[44] = 2; data[45] = 1;
      result = { context: { slot: 100 }, value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [data.toString('base64'), 'base64'] } };
    } else { assert.equal(body.method, 'getProgramAccountsV2'); result = { context: { slot: 101 }, value: { accounts: [], paginationKey: null } }; }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  } };
}
async function withServer(config, transport, run) {
  const server = await createHostedTokenLookupServer(config, { fetchImpl: transport });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (route = '/api/report', body = input, extra = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { Host: 'pilot.example', Authorization: auth, Origin: env.TA_LOOKUP_ORIGIN, 'Content-Type': 'application/json', ...extra } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
  try { await run(request, server); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('hosted configuration fails closed and analysis is opt-in', async () => {
  for (const change of [{ TA_LOOKUP_USERNAME: '' }, { TA_LOOKUP_PASSWORD: 'short' }, { TA_LOOKUP_ORIGIN: 'http://pilot.example' },
    { TA_LOOKUP_ORIGIN: 'https://pilot.example/' }, { TA_LOOKUP_ORIGIN: 'https://user:secret@pilot.example' },
    { TA_LOOKUP_ANALYSIS_ENABLED: 'yes' }, { TA_LOOKUP_ANALYSIS_ENABLED: 'true' }, { TA_LOOKUP_REQUEST_BUDGET: 'Infinity' }]) {
    await assert.rejects(createHostedTokenLookupServer({ ...env, ...change }), { message: 'Hosted lookup configuration invalid.' });
  }
  for (const p of [undefined, '', '0', '65536', '01', '1.5']) assert.throws(() => parseHostedLookupPort(p));
  assert.equal(parseHostedLookupPort('10000'), 10000);
  await withServer(env, () => { throw Error('must not call'); }, async request => {
    assert.equal((await request()).status, 503);
    const page = await request('/', '', {}, 'GET');
    assert.equal(page.status, 200); assert.match(page.text, /Analysis disabled/);
    assert.match(page.text, /id="address-form"/); assert.doesNotMatch(page.text, /loopback|Local prototype/);
  });
});
test('authentication precedes all routes; exact origin, host, size and shape gates prevent dispatch', async () => {
  let calls = 0;
  await withServer({ ...env, TA_LOOKUP_ANALYSIS_ENABLED: 'true', TA_LOOKUP_REQUEST_BUDGET: '22' }, async () => { calls++; throw Error('unexpected'); }, async request => {
    for (const route of ['/', '/app.js', '/styles.css', '/public-report.json', '/api/report', '/.env']) {
      assert.equal((await request(route, '', { Authorization: '' }, 'GET')).status, 401);
    }
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { Host: 'evil.example', 'X-Forwarded-Host': 'pilot.example' }]) assert.equal((await request('/api/report', input, headers)).status, 403);
    assert.equal((await request('/api/report', input, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await request('/api/report', 'x'.repeat(1025))).status, 413);
    for (const body of ['{', '{}', JSON.stringify({ chain: 'solana', assetAddress: MINT, endpoint: 'https://evil.example' })]) assert.equal((await request('/api/report', body)).status, 400);
    assert.equal((await request('/.env', '', {}, 'GET')).status, 404);
    assert.equal(calls, 0);
  });
});
test('authenticated assets have safe headers; failed-auth throttle is bounded', async () => {
  await withServer(env, undefined, async request => {
    for (const route of ['/', '/app.js', '/styles.css', '/public-report.json']) {
      const r = await request(route, '', {}, 'GET'); assert.equal(r.status, 200);
      assert.equal(r.headers['cache-control'], 'no-store'); assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    }
    assert.equal((await request('/', '', { Authorization: [auth, auth] }, 'GET')).status, 401);
    for (let i = 0; i < 9; i++) assert.equal((await request('/', '', { Authorization: 'Basic invalid' }, 'GET')).status, 401);
    assert.equal((await request('/', '', {}, 'GET')).status, 429);
  });
});
test('real service uses only offline transport and enforces persistent per-instance budget', async () => {
  const prior = process.env.HELIUS_API_KEY; process.env.HELIUS_API_KEY = 'offline-placeholder';
  const f = fixture();
  try {
    await withServer({ ...env, TA_LOOKUP_ANALYSIS_ENABLED: 'true', TA_LOOKUP_REQUEST_BUDGET: '22' }, f.fetchImpl, async request => {
      const first = await request(); assert.equal(first.status, 200, first.text);
      const report = JSON.parse(first.text); assert.equal(report.schemaVersion, 'token-public-report-v1'); assert.equal(report.token.assetId, MINT);
      assert.doesNotMatch(first.text, /offline-placeholder|rawOwnerAuthorities|operationalTelemetry/);
      assert.equal(f.calls.length, 3);
      const second = await request(); assert.equal(second.status, 429); assert.equal(JSON.parse(second.text).error.code, 'budget_exhausted');
      assert.equal(f.calls.length, 3);
    });
  } finally { if (prior === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = prior; }
});
test('concurrent lookup is rejected and disconnect cancels provider work', async () => {
  const prior = process.env.HELIUS_API_KEY; process.env.HELIUS_API_KEY = 'offline-placeholder';
  let enter; const entered = new Promise(resolve => enter = resolve); let aborted; const cancelled = new Promise(resolve => aborted = resolve);
  try {
    await withServer({ ...env, TA_LOOKUP_ANALYSIS_ENABLED: 'true', TA_LOOKUP_REQUEST_BUDGET: '44' }, async (_url, init) => {
      enter(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted(); reject(new Error('offline abort')); }, { once: true }));
    }, async (request, server) => {
      const first = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/report', method: 'POST', headers: { Host: 'pilot.example', Origin: env.TA_LOOKUP_ORIGIN, Authorization: auth, 'Content-Type': 'application/json' } });
      first.on('error', () => {}); first.end(input); await entered;
      const second = await request(); assert.equal(second.status, 429); assert.equal(JSON.parse(second.text).error.code, 'admission_rejected');
      first.destroy(); await cancelled;
    });
  } finally { if (prior === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = prior; }
});

test('construction performs no outbound calls and executable startup errors are sanitized', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    global.fetch = () => { throw Error('network forbidden'); };
    require('node:net').Socket.prototype.connect = () => { throw Error('network forbidden'); };
    require('node:tls').connect = () => { throw Error('network forbidden'); };
    const { createHostedTokenLookupServer } = require('./dist/hosted/tokenLookupServer.js');
    createHostedTokenLookupServer(${JSON.stringify(env)}).then(server => server.close()).catch(() => process.exit(1));
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
  const startup = spawnSync(process.execPath, ['dist/hosted/tokenLookupServer.js'], {
    env: { ...process.env, PORT: 'invalid-offline-placeholder', TA_LOOKUP_PASSWORD: 'private-placeholder' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(startup.status, 1); assert.equal(startup.stdout, '');
  assert.equal(startup.stderr, 'Hosted lookup startup failed.\n');
});
