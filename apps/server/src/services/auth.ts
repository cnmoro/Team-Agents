import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { UserModel, type UserDoc } from '../models/user.js';
import { unauthorized } from './errors.js';

const COOKIE_NAME = 'teamagents_token';
const TOKEN_TTL = '30d';

export interface TokenPayload {
  sub: string;
  username: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(user: UserDoc): string {
  const payload: TokenPayload = { sub: String(user._id), username: user.username };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
  } catch {
    return null;
  }
}

export function setAuthCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

/**
 * Reads the token from the cookie or, as a fallback, the Authorization header.
 * The header path exists so the socket handshake and API clients can
 * authenticate without a browser cookie jar.
 */
export function extractToken(request: {
  cookies?: Record<string, string | undefined>;
  headers: Record<string, unknown>;
}): string | null {
  const cookieToken = request.cookies?.[COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const header = request.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  return null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`; safe to read in any handler behind it. */
    currentUser: UserDoc;
  }
}

/** Fastify preHandler that rejects unauthenticated requests. */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  const token = extractToken(request as never);
  if (!token) throw unauthorized();
  const payload = verifyToken(token);
  if (!payload) throw unauthorized('Session expired or invalid');
  const user = await UserModel.findById(payload.sub);
  if (!user) throw unauthorized('Account no longer exists');
  request.currentUser = user;
}

export { COOKIE_NAME };
