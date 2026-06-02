/**
 * lib/auth.ts
 * Session management, Turnstile verification, OTP utilities, and SMTP transport.
 */

import crypto       from 'crypto';
import nodemailer   from 'nodemailer';
import type { Request, Response, NextFunction } from 'express';
import { getDb }    from '../db';
import type { AuthUser } from '../types';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OTP_TTL_MS     = 10 * 60 * 1000;           // 10 minutes

// ── SMTP transport (lazy-initialised) ────────────────────────────────────────

let _transport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host:       process.env.SMTP_HOST,
    port:       parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure:     process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_STARTTLS === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
  return _transport;
}

export async function sendMail(
  to: string,
  subject: string,
  text: string,
  html?: string,
): Promise<void> {
  const transport = getTransport();
  await transport.sendMail({
    from:    process.env.SMTP_FROM ?? 'TLS <noreply@localhost>',
    to,
    subject,
    text,
    html: html ?? text,
  });
}

// ── OTP helpers ──────────────────────────────────────────────────────────────

function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export interface OtpResult {
  otp:       string;
  tempToken: string;
}

/**
 * Stores an OTP in the database for a given purpose.
 */
export function createOtp(userId: number, purpose: '2fa_login' | 'invite'): OtpResult {
  const db        = getDb();
  const otp       = generateOtp();
  const tempToken = crypto.randomBytes(32).toString('hex');
  const now       = Date.now();

  db.prepare(`
    INSERT INTO otp_tokens (user_id, token, purpose, expires_at, used, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(userId, `${tempToken}:${otp}`, purpose, now + OTP_TTL_MS, now);

  return { otp, tempToken };
}

/**
 * Verifies a tempToken + OTP pair.
 * Returns the userId on success, null on failure.
 */
export function verifyOtp(tempToken: string, otp: string, purpose: '2fa_login' | 'invite'): number | null {
  const db  = getDb();
  const now = Date.now();

  const rows = db.prepare(`
    SELECT id, user_id, token FROM otp_tokens
    WHERE purpose = ? AND used = 0 AND expires_at > ?
  `).all(purpose, now) as Array<{ id: number; user_id: number; token: string }>;

  for (const row of rows) {
    const [storedTemp, storedOtp] = row.token.split(':');
    if (storedTemp === tempToken && storedOtp === otp) {
      db.prepare('UPDATE otp_tokens SET used = 1 WHERE id = ?').run(row.id);
      return row.user_id;
    }
  }
  return null;
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

export function parseCookies(req: Request): Record<string, string> {
  const map: Record<string, string> = {};
  const header = req.headers.cookie ?? '';
  header.split(';').forEach(part => {
    const [k, ...rest] = part.split('=');
    if (k) map[k.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return map;
}

// ── Session management ────────────────────────────────────────────────────────

function buildSessionCookie(req: Request, token: string, maxAgeSeconds: number): string {
  const parts = [
    `session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Creates a new session for a user and sets the session cookie on res.
 */
export function createSession(userId: number, req: Request, res: Response): string {
  const db    = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const now   = Date.now();

  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, now, now + SESSION_TTL_MS);

  res.setHeader(
    'Set-Cookie',
    buildSessionCookie(req, token, SESSION_TTL_MS / 1000),
  );
  return token;
}

export function destroySession(token: string | undefined, req: Request, res: Response): void {
  if (token) {
    try {
      getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
    } catch { /* ignore */ }
  }
  res.setHeader('Set-Cookie', buildSessionCookie(req, '', 0));
}

/**
 * Resolves a session token to an AuthUser row.
 */
export function resolveSession(token: string | undefined): AuthUser | null {
  if (!token) return null;
  const db  = getDb();
  const now = Date.now();

  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role,
           u.force_password_change, u.two_fa_enabled, u.enabled
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now) as AuthUser | undefined;

  return row ?? null;
}

// ── Express middleware ────────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req);
  const user    = resolveSession(cookies.session);

  if (!user) {
    res.status(401).json({ error: 'Unauthorised' });
    return;
  }
  if (!user.enabled) {
    res.status(403).json({ error: 'Account disabled' });
    return;
  }
  req.user         = user;
  req.sessionToken = cookies.session;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  });
}

// ── Cloudflare Turnstile ─────────────────────────────────────────────────────

export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // Turnstile disabled in development

  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const data = await resp.json() as { success: boolean };
    return data.success === true;
  } catch (err) {
    console.error('[turnstile] verification error:', (err as Error).message);
    return false;
  }
}
