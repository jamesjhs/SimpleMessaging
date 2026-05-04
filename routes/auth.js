'use strict';

/**
 * routes/auth.js
 * Login, logout, OTP verification, and password change endpoints.
 */

const express = require('express');
const { getDb, hashPassword, verifyPassword } = require('../db');
const {
  createSession,
  destroySession,
  parseCookies,
  requireAuth,
  createOtp,
  verifyOtp,
  sendMail,
  verifyTurnstile,
} = require('../lib/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password, turnstileToken } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  // Verify Cloudflare Turnstile (skip if site key not configured)
  const turnstileOk = await verifyTurnstile(turnstileToken, req.ip);
  if (!turnstileOk) return res.status(403).json({ error: 'Captcha verification failed' });

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.enabled) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  // 2FA required?
  if (user.two_fa_enabled && user.email) {
    const { otp, tempToken } = createOtp(user.id, '2fa_login');
    const appUrl = process.env.APP_URL || 'http://localhost:3333';
    try {
      await sendMail(
        user.email,
        'Your TLS login code',
        `Your one-time login code is: ${otp}\n\nThis code expires in 10 minutes.`,
        `<p>Your one-time login code is: <strong>${otp}</strong></p><p>This code expires in 10 minutes.</p>`
      );
    } catch (err) {
      console.error('[auth] Failed to send 2FA email:', err.message);
      return res.status(500).json({ error: 'Failed to send 2FA code. Check SMTP configuration.' });
    }
    return res.json({ status: '2fa_required', tempToken });
  }

  // No 2FA – create session
  createSession(user.id, res);

  return res.json({
    status: user.force_password_change ? 'change_password' : 'ok',
    user: { displayName: user.display_name, role: user.role },
  });
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  const { tempToken, otp } = req.body || {};
  if (!tempToken || !otp) return res.status(400).json({ error: 'tempToken and otp required' });

  const userId = verifyOtp(tempToken, otp, '2fa_login');
  if (!userId) return res.status(401).json({ error: 'Invalid or expired code' });

  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.enabled) return res.status(401).json({ error: 'Account disabled' });

  createSession(user.id, res);

  return res.json({
    status: user.force_password_change ? 'change_password' : 'ok',
    user: { displayName: user.display_name, role: user.role },
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const cookies = parseCookies(req);
  destroySession(cookies.session, res);
  res.sendStatus(204);
});

// POST /api/auth/change-password  (requires active session)
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  const ok = await verifyPassword(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, force_password_change = 0 WHERE id = ?')
    .run(hash, user.id);

  return res.json({ status: 'ok' });
});

module.exports = router;
