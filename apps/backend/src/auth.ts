import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import type { AppContext, AuthUser } from "./types.js";

const SESSION_COOKIE = "openoverlay_session";
export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
export const DUMMY_PASSWORD_HASH = "$2b$12$Z/ol5FhQtDfWEbV5DJzv8e0ysi5A1CcxldBtpJ4lqnvyqCBbn7R4K";

export interface SessionPayload {
  sub: string;
  exp: number;
  ver: number;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class AuthRateLimiter {
  private readonly loginByIdentity = new Map<string, RateBucket>();
  private readonly loginByIp = new Map<string, RateBucket>();
  private readonly signupByIp = new Map<string, RateBucket>();
  private readonly uploadByIdentity = new Map<string, RateBucket>();
  private readonly writeByIdentity = new Map<string, RateBucket>();
  private readonly writeByIp = new Map<string, RateBucket>();
  private readonly sensitiveReadByIdentity = new Map<string, RateBucket>();
  private readonly sensitiveReadByIp = new Map<string, RateBucket>();
  private readonly actionByPreset = new Map<string, RateBucket>();

  reserveLogin(email: string, ip: string, now = Date.now()): void {
    consumeRate(this.loginByIp, ip, 60, 15 * 60_000, now, "Too many login attempts");
    consumeRate(this.loginByIdentity, `${email}:${ip}`, 5, 15 * 60_000, now, "Too many failed attempts");
  }

  recordSuccessfulLogin(email: string, ip: string): void {
    this.loginByIdentity.delete(`${email}:${ip}`);
  }

  reserveSignup(ip: string, now = Date.now()): void {
    consumeRate(this.signupByIp, ip, 5, 60 * 60_000, now, "Too many signup attempts");
  }

  reserveUpload(userId: string, ip: string, now = Date.now()): void {
    consumeRate(this.uploadByIdentity, `${userId}:${ip}`, 60, 10 * 60_000, now, "Too many upload attempts");
  }

  reserveWrite(userId: string, ip: string, now = Date.now()): void {
    consumeRate(this.writeByIp, ip, 1_200, 10 * 60_000, now, "Too many write requests");
    consumeRate(this.writeByIdentity, userId, 600, 10 * 60_000, now, "Too many write requests");
  }

  reserveSensitiveRead(userId: string, ip: string, now = Date.now()): void {
    consumeRate(this.sensitiveReadByIp, ip, 240, 10 * 60_000, now, "Too many sensitive read requests");
    consumeRate(this.sensitiveReadByIdentity, userId, 120, 10 * 60_000, now, "Too many sensitive read requests");
  }

  reserveAction(presetId: string, ip: string, now = Date.now()): void {
    consumeRate(this.writeByIp, ip, 1_200, 10 * 60_000, now, "Too many action requests");
    consumeRate(this.actionByPreset, presetId, 600, 10 * 60_000, now, "Too many action requests");
  }
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createSessionToken(userId: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000), sessionVersion = 1): string {
  const payload: SessionPayload = {
    sub: userId,
    exp: nowSeconds + SESSION_TTL_SECONDS,
    ver: sessionVersion
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(body, secret);
  return `${body}.${signature}`;
}

export function verifySessionToken(token: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): SessionPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;
  const expected = sign(body, secret);
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= nowSeconds ||
      !Number.isSafeInteger(payload.ver) ||
      payload.ver < 1
    )
      return null;
    return payload;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, ctx: AppContext, userId: string, sessionVersion: number): void {
  const token = createSessionToken(userId, ctx.config.jwtSecret, Math.floor(Date.now() / 1000), sessionVersion);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: ctx.config.env === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
    domain: ctx.config.cookieDomain
  });
}

export function clearSessionCookie(res: Response, ctx: AppContext): void {
  res.clearCookie(SESSION_COOKIE, {
    path: "/",
    domain: ctx.config.cookieDomain
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const ctx = req.ctx;
  if (!ctx) {
    res.status(500).json({ error: "Missing app context" });
    return;
  }

  const user = authenticatedUser(req, ctx);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  req.user = user;
  next();
}

export function serializeUser(user: AuthUser) {
  return { id: user.id, email: user.email };
}

export function validateEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password, "utf8") > 72) return null;
  return password;
}

export function authenticatedUser(req: Request, ctx: AppContext, headerOnly = false): AuthUser | null {
  const authorization = req.header("authorization");
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const headerToken = req.header("x-openoverlay-session");
  const tokens = headerOnly ? [bearer, headerToken] : [bearer, headerToken, req.cookies?.[SESSION_COOKIE] as string | undefined];
  for (const token of tokens) {
    const payload = verifySessionToken(token, ctx.config.jwtSecret);
    if (!payload) continue;
    const user = ctx.db.findUserById(payload.sub);
    if (user && user.session_version === payload.ver) return { id: user.id, email: user.email };
  }
  return null;
}

export function generateActionKey(): string {
  return `ooa_${randomBytes(24).toString("base64url")}`;
}

export function hashActionKey(actionKey: string): string {
  return createHash("sha256").update(actionKey).digest("hex");
}

export function verifyActionKey(actionKey: string | undefined, actionKeyHash: string | null): boolean {
  if (!actionKey || !actionKeyHash) return false;
  return safeEqual(hashActionKey(actionKey), actionKeyHash);
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function consumeRate(buckets: Map<string, RateBucket>, key: string, limit: number, windowMs: number, now: number, message: string): void {
  pruneBuckets(buckets, now);
  const current = buckets.get(key);
  if (current && current.resetAt > now && current.count >= limit) {
    throw new RateLimitError(message, Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
  }
  const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  bucket.count += 1;
  buckets.delete(key);
  buckets.set(key, bucket);
  if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value as string);
}

function pruneBuckets(buckets: Map<string, RateBucket>, now: number): void {
  if (buckets.size < 100) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}
