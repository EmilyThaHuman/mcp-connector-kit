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
  _def?: {
    typeName?: string;
    description?: string;
    /** ZodArray: element schema. ZodOptional/ZodDefault: inner schema. */
    type?: ZodLike;
    innerType?: ZodLike;
  };
  description?: string;
  shape?: Record<string, ZodLike> | (() => Record<string, ZodLike>);
}

interface JsonSchemaNode {
  type?: string;
  description?: string;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolHandler {
  /** Canonical name, e.g. `send_email`. */
  name: string;
  description: string;
  /** A Zod schema or an authoritative JSON Schema object. */
  inputSchema: ZodLike | JsonSchemaNode;
  /** Authoritative result contract, preserved verbatim in tools/list. */
  outputSchema?: JsonSchemaNode;
  /** Provider export hint retained for clients that support deferred tools. */
  deferLoading?: boolean;
  /** Standard MCP behavior hints used by clients for safety and grouping. */
  annotations?: ToolAnnotations;
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
  /**
   * `jwt` (default) verifies the ZeroTwoApi JWT on every tools/call. `none` is
   * for public read-only workers: no JWT is checked and handlers receive an
   * anonymous placeholder identity.
   */
  auth?: 'jwt' | 'none';
}

export function createMcpApp<E extends KitEnv = KitEnv>(
  opts: CreateMcpAppOptions,
): Hono<{ Bindings: E }> {
  const allowedOrigins = new Set(opts.corsOrigins ?? DEFAULT_CORS_ORIGINS);
  const handlersByName = new Map<string, ToolHandler>();
  for (const handler of opts.toolHandlers) {
    for (const name of handlerNames(handler.name, opts.connectorId)) {
      handlersByName.set(name, handler);
    }
  }

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
        inputSchema: normalizeInputSchema(h.inputSchema),
        ...(h.outputSchema ? { outputSchema: h.outputSchema } : {}),
        ...(h.annotations ? { annotations: h.annotations } : {}),
        ...(h.deferLoading === undefined ? {} : { defer_loading: h.deferLoading }),
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
        if (opts.auth === 'none') {
          claims = {
            user_id: 'anonymous',
            provider_id: opts.connectorId,
            connection_id: 'anonymous',
          };
          jwt = '';
        } else {
          const verified = await verifyJwt(c.req.raw, c.env as unknown as KitEnv);
          claims = verified.claims;
          jwt = verified.token;
        }
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

function handlerNames(name: string, connectorId: string): string[] {
  const names = new Set([name]);
  if (connectorId) {
    const normalized = connectorId.replace(/-/g, '_');
    names.add(`${normalized}_${name}`);
    names.add(`mcp__${normalized}__${name}`);
  }
  if (connectorId === 'quickbooks') {
    names.add(`qb_${name}`);
  }
  if (connectorId === 'retell_ai') {
    names.add(`retell_${name}`);
  }
  return [...names];
}

function resolveShape(schema: ZodLike): Record<string, ZodLike> | null {
  const shape = schema?.shape;
  if (!shape) return null;
  if (typeof shape === 'function') {
    try {
      return shape();
    } catch {
      return null;
    }
  }
  if (typeof shape === 'object') return shape;
  return null;
}

function zodNodeToJsonSchema(node: ZodLike): JsonSchemaNode {
  const typeName = node?._def?.typeName;

  // Unwrap ZodOptional / ZodDefault — describe the inner type, optionality is
  // tracked at the parent level via the `required` array.
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault') {
    const inner = node._def?.innerType;
    if (inner) {
      const innerSchema = zodNodeToJsonSchema(inner);
      const description = node.description ?? node._def?.description;
      if (description && !innerSchema.description) innerSchema.description = description;
      return innerSchema;
    }
  }

  const description = node?.description ?? node?._def?.description;
  const result: JsonSchemaNode = { type: zodTypeNameToJsonType(typeName) };
  if (description) result.description = description;

  if (typeName === 'ZodArray') {
    const elementSchema = node._def?.type;
    result.items = elementSchema
      ? zodNodeToJsonSchema(elementSchema)
      : { type: 'string' };
  } else if (typeName === 'ZodObject') {
    const inner = resolveShape(node);
    if (inner) {
      const properties: Record<string, JsonSchemaNode> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(inner)) {
        properties[key] = zodNodeToJsonSchema(value);
        const childTypeName = value?._def?.typeName;
        if (childTypeName && childTypeName !== 'ZodOptional' && childTypeName !== 'ZodDefault') {
          required.push(key);
        }
      }
      result.properties = properties;
      result.required = required;
    }
  }

  return result;
}

function zodShapeToJsonSchema(schema: ZodLike): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  const shape = resolveShape(schema);
  if (shape) {
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodNodeToJsonSchema(value);
      const typeName = value?._def?.typeName;
      if (typeName && typeName !== 'ZodOptional' && typeName !== 'ZodDefault') {
        required.push(key);
      }
    }
  }
  return { type: 'object', properties, required };
}

function normalizeInputSchema(schema: ZodLike | JsonSchemaNode): JsonSchemaNode {
  if (
    schema &&
    typeof schema === 'object' &&
    'type' in schema &&
    schema.type === 'object' &&
    'properties' in schema &&
    schema.properties &&
    typeof schema.properties === 'object'
  ) {
    return schema as JsonSchemaNode;
  }
  return zodShapeToJsonSchema(schema as ZodLike);
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
