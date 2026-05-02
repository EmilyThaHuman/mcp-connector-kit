/**
 * Internal callback to ZeroTwoApi for the upstream OAuth token.
 *
 * The connector forwards the same JWT it received as Bearer; ZeroTwoApi
 * verifies it again, locates the connection by `connection_id`, and
 * returns the decrypted upstream bearer.
 *
 * No retry / no caching: the JWT is per-call and the upstream token can
 * rotate at any time. On 401 from the upstream API, callers should fail
 * the tool call and let the next call pull a fresh token (the refresh
 * queue worker on ZeroTwoApi is responsible for rotating expired tokens).
 */

import type { KitEnv } from './jwt.js';

export interface UpstreamToken {
  accessToken: string;
  tokenType: string;
  expiresAt: string | null;
  scopes: string[];
}

export type UpstreamTokenErrorCode =
  | 'JWT_MISSING'
  | 'JWT_INVALID'
  | 'PROVIDER_MISMATCH'
  | 'CONNECTION_NOT_FOUND'
  | 'TOKEN_NOT_FOUND'
  | 'CONNECTION_NEEDS_AUTH'
  | 'UPSTREAM_TOKEN_REQUEST_FAILED';

export class UpstreamTokenError extends Error {
  code: UpstreamTokenErrorCode;
  status: number;
  details?: unknown;

  constructor(code: UpstreamTokenErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'UpstreamTokenError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface RawTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_at?: string | null;
  scopes?: string[];
}

interface RawErrorResponse {
  error?: string;
  code?: string;
  status?: string;
}

const KNOWN_ERROR_CODES: ReadonlySet<UpstreamTokenErrorCode> = new Set([
  'JWT_MISSING',
  'JWT_INVALID',
  'PROVIDER_MISMATCH',
  'CONNECTION_NOT_FOUND',
  'TOKEN_NOT_FOUND',
  'CONNECTION_NEEDS_AUTH',
]);

export async function fetchUpstreamToken(jwt: string, env: KitEnv): Promise<UpstreamToken> {
  const url = `${env.ZEROTWO_API_URL.replace(/\/$/, '')}/internal/mcp/upstream-token`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    throw new UpstreamTokenError(
      'UPSTREAM_TOKEN_REQUEST_FAILED',
      0,
      `Failed to reach ZeroTwoApi: ${message}`,
      err,
    );
  }

  const text = await res.text();
  let json: RawTokenResponse & RawErrorResponse = {};
  if (text) {
    try {
      json = JSON.parse(text) as RawTokenResponse & RawErrorResponse;
    } catch {
      throw new UpstreamTokenError(
        'UPSTREAM_TOKEN_REQUEST_FAILED',
        res.status,
        `ZeroTwoApi returned non-JSON: ${text.slice(0, 200)}`,
      );
    }
  }

  if (!res.ok) {
    const rawCode = json.code;
    const code: UpstreamTokenErrorCode =
      rawCode && KNOWN_ERROR_CODES.has(rawCode as UpstreamTokenErrorCode)
        ? (rawCode as UpstreamTokenErrorCode)
        : 'UPSTREAM_TOKEN_REQUEST_FAILED';
    throw new UpstreamTokenError(
      code,
      res.status,
      json.error || `Upstream-token request failed (${res.status})`,
      json,
    );
  }

  if (!json.access_token) {
    throw new UpstreamTokenError(
      'TOKEN_NOT_FOUND',
      res.status,
      'Upstream-token response missing access_token',
      json,
    );
  }

  return {
    accessToken: json.access_token,
    tokenType: json.token_type || 'Bearer',
    expiresAt: json.expires_at ?? null,
    scopes: Array.isArray(json.scopes) ? json.scopes : [],
  };
}
