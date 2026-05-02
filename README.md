# @zerotwo/mcp-connector-kit

Shared TypeScript kit for ZeroTwo remote MCP connectors running on Cloudflare
Workers. Each connector is a thin tool host: this kit provides the glue.

## What it does

- **`verifyJwt(req, env)`** — verifies the short-lived RS256 JWT minted by
  ZeroTwoApi against the JWKS at `${ZEROTWO_API_URL}/.well-known/jwks.json`
  (cached 1h via `jose.createRemoteJWKSet`). Returns typed claims
  `{ user_id, provider_id, connection_id, scopes? }` and the raw token.
- **`fetchUpstreamToken(jwt, env)`** — calls `POST ${ZEROTWO_API_URL}/internal/mcp/upstream-token`
  forwarding the same JWT and returns the decrypted upstream OAuth bearer.
- **`createMcpApp({ connectorId, serverInfo, toolHandlers })`** — returns a
  Hono app that implements the `POST /mcp` JSON-RPC endpoint plus the SSE
  shim, dispatches `tools/list` and `tools/call`, runs JWT verification, and
  wraps every handler in an `errorBoundary`.
- **`errorBoundary(fn)` / `mcpError(text)`** — produce the standard MCP
  `{ isError: true, content: [{ type: 'text', text }] }` envelope.

## Install

This is a private package. Connectors in the same repo consume it via a file
path:

```json
{
  "dependencies": {
    "@zerotwo/mcp-connector-kit": "file:../mcp-connector-kit"
  }
}
```

## Worker env (`wrangler.toml`)

```toml
[vars]
CONNECTOR_ID = "gmail"                       # Must match the JWT `aud` claim
ZEROTWO_API_URL = "https://api.zerotwo.ai"
ZEROTWO_API_ISSUER = "https://api.zerotwo.ai" # Optional, defaults to ZEROTWO_API_URL
```

## Minimal connector

```ts
import { z } from 'zod';
import {
  createMcpApp,
  errorBoundary,
  fetchUpstreamToken,
  type ToolHandler,
} from '@zerotwo/mcp-connector-kit';

const sendEmail: ToolHandler = {
  name: 'mcp__gmail__send_email',
  description: 'Send an email via Gmail.',
  inputSchema: z.object({
    to: z.string(),
    subject: z.string(),
    body: z.string(),
  }),
  execute: async ({ args, jwt, env }) =>
    errorBoundary(async () => {
      const { accessToken } = await fetchUpstreamToken(jwt, env);
      const res = await fetch('https://gmail.googleapis.com/.../send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }),
};

export default createMcpApp({
  connectorId: 'gmail',
  serverInfo: { name: 'gmail-mcp', version: '1.0.0' },
  toolHandlers: [sendEmail],
});
```

## Build

```bash
npm install
npm run typecheck
npm run build
```
