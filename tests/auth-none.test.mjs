import test from 'node:test';
import assert from 'node:assert/strict';

// Run against the build: `npm test` builds first. KIT_DIST overrides the folder under test.
const { createMcpApp } = await import(process.env.KIT_DIST ?? '../dist/index.js');

const ping = {
  name: 'ping',
  description: 'ping',
  inputSchema: { type: 'object', properties: {} },
  execute: async ({ claims, jwt }) => ({ content: [{ type: 'text', text: `pong ${claims.user_id} ${claims.provider_id} jwt="${jwt}"` }] }),
};

const call = (app) =>
  app
    .request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } }),
      },
      { CONNECTOR_ID: 'x', ZEROTWO_API_URL: 'https://api.zerotwo.ai' },
    )
    .then((r) => r.json());

const make = (extra = {}) =>
  createMcpApp({ connectorId: 'x', serverInfo: { name: 'x', version: '1' }, toolHandlers: [ping], ...extra });

test("default auth still requires a JWT on tools/call", async () => {
  const { result } = await call(make());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^JWT_MISSING/);
});

test("auth 'none' runs the tool with an anonymous identity and no JWT", async () => {
  const { result } = await call(make({ auth: 'none' }));
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'pong anonymous x jwt=""');
});
