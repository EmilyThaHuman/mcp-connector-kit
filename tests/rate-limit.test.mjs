import test from 'node:test';
import assert from 'node:assert/strict';

const { createMcpApp } = await import(process.env.KIT_DIST ?? '../dist/index.js');

const ping = {
  name: 'ping',
  description: 'ping',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
};

const make = (extra) =>
  createMcpApp({ connectorId: 'x', serverInfo: { name: 'x', version: '1' }, toolHandlers: [ping], ...extra });

const call = (app, ip, method = 'tools/call') =>
  app.request(
    '/mcp',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'ping', arguments: {} } }),
    },
    { CONNECTOR_ID: 'x', ZEROTWO_API_URL: 'https://api.zerotwo.ai' },
  );

test("auth 'none' answers 429 with Retry-After once a client spends its burst, other clients are unaffected", async () => {
  const app = make({ auth: 'none', rateLimit: { burst: 2, perSec: 0.5 } });
  assert.equal((await call(app, '1.1.1.1')).status, 200);
  assert.equal((await call(app, '1.1.1.1')).status, 200);
  const limited = await call(app, '1.1.1.1');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '2');
  assert.match((await limited.json()).error.message, /Rate limited.*2s/);
  assert.equal((await call(app, '2.2.2.2')).status, 200);
});

test("only tools/call is limited; tools/list stays free", async () => {
  const app = make({ auth: 'none', rateLimit: { burst: 1, perSec: 0.001 } });
  assert.equal((await call(app, '3.3.3.3')).status, 200);
  assert.equal((await call(app, '3.3.3.3')).status, 429);
  assert.equal((await call(app, '3.3.3.3', 'tools/list')).status, 200);
});

test("the default JWT mode is not rate limited (ZeroTwoApi gates it)", async () => {
  const app = make({ rateLimit: { burst: 1, perSec: 0.001 } });
  for (let i = 0; i < 3; i++) assert.equal((await call(app, '4.4.4.4')).status, 200);
});

test("the default budget lets a normal burst through", async () => {
  const app = make({ auth: 'none' });
  for (let i = 0; i < 30; i++) assert.equal((await call(app, '5.5.5.5')).status, 200);
  assert.equal((await call(app, '5.5.5.5')).status, 429);
});
