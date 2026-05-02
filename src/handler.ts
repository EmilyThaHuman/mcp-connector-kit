/**
 * Cloudflare Workers ↔ MCP transport adapter.
 *
 * The MCP SDK as of v1.12 has no built-in HTTP transport for Workers, so we
 * hand-roll JSON-RPC over HTTP matching the legacy connector pattern. This
 * keeps the surface drop-in for the existing ZeroTwoApi outbound MCP client.
 *
 * Routes:
 *   POST /mcp   — JSON-RPC entrypoint (initialize, tools/list, tools/call, ...)
 *   GET  /mcp   — SSE shim for clients that probe for SSE transport
 *   GET  /sse   — Same SSE shim under the legacy URL
 *   OPTIONS *   — CORS preflight
 */

import { Hono, type Context } from 'hono';

import { errorBoundary, mcpError, type McpToolResult } from './errors.js';
import { JwtError, verifyJwt, type JwtClaims, type KitEnv } from './jwt.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://zerotwo.app',
  'https://zerotwo.ai',
  'https://www.zerotwo.ai',
];

/** Lightweight Zod-shape introspection — mirrors the legacy connector pattern
 * so consumers don't need to add `zod-to-json-schema` as a dep. */
interface ZodLike {
  _def?: { typeName?: string; description?: string };
  description?: string;
  shape?: Record<string, ZodLike>;
}

export interface ToolHandler {
  /** Canonical name, e.g. `mcp__gmail__send_email`. */
  name: string;
  description: string;
  /** A Zod schema (typed loosely so the kit stays zod-free). */
  inputSchema: ZodLike;
  execute: (ctx: {
    args: Record<string, unknown>;
    claims: JwtClaims;
    jwt: string;
    env: KitEnv;
  }) => Promise<McpToolResult>;
}

export interface CreateMcpAppOptions {
  connectorId: string;
  serverInfo: { name: string; version: string };
  toolHandlers: ToolHandler[];
  /** Override the default CORS allowlist. */
  corsOrigins?: string[];
}

export function createMcpApp<E extends KitEnv = KitEnv>(
  opts: CreateMcpAppOptions,
): Hono<{ Bindings: E }> {
  const allowedOrigins = new Set(opts.corsOrigins ?? DEFAULT_CORS_ORIGINS);
  const handlersByName = new Map(opts.toolHandlers.map((h) => [h.name, h]));

  const app = new Hono<{ Bindings: E }>();

  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin') || '';
    const allow = allowedOrigins.has(origin)
      ? origin
      : origin.endsWith('.zerotwo.ai')
        ? origin
        : '';
    if (allow) {
      c.header('Access-Control-Allow-Origin', allow);
      c.header('Vary', 'Origin');
    }
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
    c.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }
    await next();
  });

  app.get('/', (c) =>
    c.json({
      name: opts.serverInfo.name,
      version: opts.serverInfo.version,
      protocol: 'mcp',
      transport: 'streamable-http',
      endpoints: { mcp: '/mcp', sse: '/sse' },
    }),
  );

  const sseShim = (c: Context) =>
    c.body(`event: endpoint\ndata: /mcp\n\n`, 200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  app.get('/mcp', sseShim);
  app.get('/sse', sseShim);

  app.post('/mcp', async (c) => {
    let body: { id?: string | number | null; method?: string; params?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        400,
      );
    }

    const id = body.id ?? null;
    const method = body.method;

    if (method === 'initialize') {
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: opts.serverInfo,
        },
      });
    }

    if (method === 'tools/list') {
      const tools = opts.toolHandlers.map((h) => ({
        name: h.name,
        description: h.description,
        inputSchema: zodShapeToJsonSchema(h.inputSchema),
      }));
      return c.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const params = (body.params || {}) as { name?: string; arguments?: Record<string, unknown> };
      const toolName = params.name;
      if (!toolName) {
        return c.json({
          jsonrpc: '2.0',
          id,
          result: mcpError('Missing tool name in tools/call'),
        });
      }
      const handler = handlersByName.get(toolName);
      if (!handler) {
        return c.json({
          jsonrpc: '2.0',
          id,
          result: mcpError(`Unknown tool: ${toolName}`),
        });
      }

      let claims: JwtClaims;
      let jwt: string;
      try {
        const verified = await verifyJwt(c.req.raw, c.env as unknown as KitEnv);
        claims = verified.claims;
        jwt = verified.token;
      } catch (err) {
        if (err instanceof JwtError) {
          return c.json({ jsonrpc: '2.0', id, result: mcpError(`${err.code}: ${err.message}`) });
        }
        const message = err instanceof Error ? err.message : 'JWT verification failed';
        return c.json({ jsonrpc: '2.0', id, result: mcpError(message) });
      }

      const result = await errorBoundary(() =>
        handler.execute({
          args: params.arguments ?? {},
          claims,
          jwt,
          env: c.env as unknown as KitEnv,
        }),
      );
      return c.json({ jsonrpc: '2.0', id, result });
    }

    if (
      method === 'notifications/initialized' ||
      method === 'notifications/cancelled' ||
      method === 'notifications/progress'
    ) {
      return c.body(null, 204);
    }

    if (method === 'resources/list') {
      return c.json({ jsonrpc: '2.0', id, result: { resources: [] } });
    }
    if (method === 'prompts/list') {
      return c.json({ jsonrpc: '2.0', id, result: { prompts: [] } });
    }

    return c.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method ?? '(none)'}` },
    });
  });

  return app;
}

function zodShapeToJsonSchema(schema: ZodLike): {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
} {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  const shape = schema?.shape;
  if (shape && typeof shape === 'object') {
    for (const [key, value] of Object.entries(shape)) {
      const typeName = value?._def?.typeName;
      const description = value?.description ?? value?._def?.description;
      const type = zodTypeNameToJsonType(typeName);
      const prop: { type: string; description?: string } = { type };
      if (description) prop.description = description;
      properties[key] = prop;
      if (typeName && typeName !== 'ZodOptional' && typeName !== 'ZodDefault') {
        required.push(key);
      }
    }
  }
  return { type: 'object', properties, required };
}

function zodTypeNameToJsonType(typeName: string | undefined): string {
  switch (typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray':
      return 'array';
    case 'ZodObject':
      return 'object';
    default:
      return 'string';
  }
}
