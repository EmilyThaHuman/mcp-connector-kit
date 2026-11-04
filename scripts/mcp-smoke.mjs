#!/usr/bin/env node
/**
 * Smoke-test a no-auth MCP worker over JSON-RPC.
 *
 *   node mcp-connector-kit/scripts/mcp-smoke.mjs <base-url> [tool '<json args>']...
 *
 * Example (local wrangler dev or a deployed worker):
 *   node mcp-connector-kit/scripts/mcp-smoke.mjs http://127.0.0.1:8801 search_labels '{"drug_name":"metoprolol","page_size":2}'
 *
 * Lists the tools, then calls each given tool and prints the first 1200
 * characters of its result. Exits non-zero if any call returns isError.
 */

const [base, ...rest] = process.argv.slice(2);
if (!base) {
  console.error('usage: mcp-smoke.mjs <base-url> [tool \'<json args>\']...');
  process.exit(2);
}

const url = `${base.replace(/\/$/, '')}/mcp`;
let nextId = 1;

async function rpc(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

let failed = false;
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
});
console.log(`server: ${init.serverInfo.name}@${init.serverInfo.version}`);
const { tools } = await rpc('tools/list', {});
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);

for (let i = 0; i < rest.length; i += 2) {
  const name = rest[i];
  const args = JSON.parse(rest[i + 1] ?? '{}');
  const result = await rpc('tools/call', { name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  console.log(`\n== ${name} ${JSON.stringify(args)} ${result.isError ? 'ERROR' : 'ok'} (${text.length} chars)`);
  console.log(text.slice(0, 1200));
  if (result.isError) failed = true;
}
process.exit(failed ? 1 : 0);
