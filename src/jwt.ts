/**
 * JWT verification for MCP-server connectors.
 *
 * The connector receives a short-lived RS256 JWT minted by ZeroTwoApi as
 * `Authorization: Bearer <jwt>`. We verify it against the JWKS at
 * `${ZEROTWO_API_URL}/.well-known/jwks.json` and assert the required claims
 * (user_id, provider_id, connection_id) are present.
 *
 * `jose.createRemoteJWKSet` handles fetch + 1h cache + cooldown internally;
 * we singleton-cache the JWKSet object per ZEROTWO_API_URL so each Worker
 * isolate makes at most one fetch every 1h.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface KitEnv {
  /** Base URL of ZeroTwoApi, e.g. `https://api.zerotwo.ai`. */
  ZEROTWO_API_URL: string;
  /** JWT `iss` claim issuer, falls back to ZEROTWO_API_URL. */
  ZEROTWO_API_ISSUER?: string;
  /** This connector's id — must match the JWT `aud` claim. */
  CONNECTOR_ID: string;
}

export interface JwtClaims extends JWTPayload {
  user_id: string;
  provider_id: string;
  connection_id: string;
  scopes?: string[];
}

export type JwtErrorCode = 'JWT_MISSING' | 'JWT_INVALID' | 'JWT_CLAIMS_MISSING';

export class JwtError extends Error {
  code: JwtErrorCode;
  cause?: unknown;

  constructor(code: JwtErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
    this.cause = cause;
  }
}

const JWKS_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const JWKS_COOLDOWN_MS = 30 * 1000;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(env: KitEnv): ReturnType<typeof createRemoteJWKSet> {
  const url = `${env.ZEROTWO_API_URL.replace(/\/$/, '')}/.well-known/jwks.json`;
  const cached = jwksCache.get(url);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(url), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
  });
  jwksCache.set(url, jwks);
  return jwks;
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return null;
  return parts[1] ?? null;
}

/**
 * Verify the bearer JWT on `req` against the ZeroTwoApi JWKS.
 * Returns the claims; throws `JwtError` with a typed code on any failure.
 *
 * The raw token is also returned so callers can forward it to
 * `fetchUpstreamToken` without re-parsing the header.
 */
export async function verifyJwt(
  req: Request,
  env: KitEnv,
): Promise<{ claims: JwtClaims; token: string }> {
  const token = extractBearer(req);
  if (!token) {
    throw new JwtError('JWT_MISSING', 'Missing or malformed Authorization header');
  }

  const issuer =
    env.ZEROTWO_API_ISSUER || env.ZEROTWO_API_URL.replace(/\/$/, '');

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getJwks(env), {
      issuer,
      audience: env.CONNECTOR_ID,
      algorithms: ['RS256'],
    });
    payload = result.payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'JWT verification failed';
    throw new JwtError('JWT_INVALID', message, err);
  }

  if (
    typeof payload.user_id !== 'string' ||
    typeof payload.provider_id !== 'string' ||
    typeof payload.connection_id !== 'string'
  ) {
    throw new JwtError(
      'JWT_CLAIMS_MISSING',
      'JWT missing required claims (user_id, provider_id, connection_id)',
    );
  }

  return { claims: payload as JwtClaims, token };
}
