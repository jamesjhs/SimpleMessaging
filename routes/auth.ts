/**
 * routes/auth.ts
 * Login, logout, OTP verification, and password-change endpoints.
 */

import { Router, Request, Response } from 'express';
import { getDb, hashPassword, verifyPassword } from '../db';
import {
  createSession,
  destroySession,
  parseCookies,
  requireAuth,
  createOtp,
  verifyOtp,
  sendMail,
  verifyTurnstile,
} from '../lib/auth';
import { rateLimiter } from '../lib/rateLimiter';
import type { DbUser } from '../types';

const router = Router();

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post(
  '/login',
  rateLimiter({ windowMs: 15 * 60_000, max: 10, message: 'Too many login attempts. Try again in 15 minutes.' }),
  async (req: Request, res: Response): Promise<void> => {
  const { username, password, turnstileToken } = req.body as {
    username?: string;
    password?: string;
    turnstileToken?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }

  const turnstileOk = await verifyTurnstile(turnstileToken, req.ip ?? '');
  if (!turnstileOk) {
    res.status(403).json({ error: 'Captcha verification failed' });
    return;
  }

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as DbUser | undefined;

  if (!user || !user.enabled) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // 2FA required?
  if (user.two_fa_enabled && user.email) {
    const { otp, tempToken } = createOtp(user.id, '2fa_login');
    try {
      await sendMail(
        user.email,
        'Your TLS login code',
        `Your one-time login code is: ${otp}\n\nThis code expires in 10 minutes.`,
        `<p>Your one-time login code is: <strong>${otp}</strong></p>
         <p>This code expires in 10&nbsp;minutes.</p>`,
      );
    } catch (err) {
      console.error('[auth] Failed to send 2FA email:', (err as Error).message);
      res.status(500).json({ error: 'Failed to send 2FA code. Check SMTP configuration.' });
      return;
    }
    res.json({ status: '2fa_required', tempToken });
    return;
  }

  // No 2FA – create session immediately
  createSession(user.id, res);
  res.json({
    status: user.force_password_change ? 'change_password' : 'ok',
    user:   { displayName: user.display_name, role: user.role },
  });
  },
);

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────

router.post(
  '/verify-otp',
  rateLimiter({ windowMs: 10 * 60_000, max: 5, message: 'Too many OTP attempts. Try again in 10 minutes.' }),
  async (req: Request, res: Response): Promise<void> => {
  const { tempToken, otp } = req.body as { tempToken?: string; otp?: string };

  if (!tempToken || !otp) {
    res.status(400).json({ error: 'tempToken and otp required' });
    return;
  }

  const userId = verifyOtp(tempToken, otp, '2fa_login');
  if (!userId) {
    res.status(401).json({ error: 'Invalid or expired code' });
    return;
  }

  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as DbUser | undefined;
  if (!user || !user.enabled) {
    res.status(401).json({ error: 'Account disabled' });
    return;
  }

  createSession(user.id, res);
  res.json({
    status: user.force_password_change ? 'change_password' : 'ok',
    user:   { displayName: user.display_name, role: user.role },
  });
  },
);

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

router.post('/logout', (req: Request, res: Response): void => {
  const cookies = parseCookies(req);
  destroySession(cookies.session, res);
  res.sendStatus(204);
});

// ── POST /api/auth/change-password  (requires active session) ────────────────

router.post(
  '/change-password',
  rateLimiter({ windowMs: 15 * 60_000, max: 10 }),
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?:     string;
  };

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'currentPassword and newPassword required' });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const db   = getDb();
  // req.user is guaranteed by requireAuth
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as DbUser;

  const ok = await verifyPassword(currentPassword, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, force_password_change = 0 WHERE id = ?')
    .run(hash, user.id);

  res.json({ status: 'ok' });
  },
);

export default router;
