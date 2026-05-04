'use strict';

/**
 * lib/auth.js
 * Session management, Turnstile verification, OTP utilities, and SMTP transport.
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getDb } = require('../db');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OTP_TTL_MS     = 10 * 60 * 1000;           // 10 minutes

// ── SMTP transport (lazy-initialised) ────────────────────────────────────────

let _transport = null;

function getTransport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host:       process.env.SMTP_HOST,
    port:       parseInt(process.env.SMTP_PORT || '587', 10),
    secure:     process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_STARTTLS === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
  return _transport;
}

async function sendMail(to, subject, text, html) {
  const transport = getTransport();
  return transport.sendMail({
    from:    process.env.SMTP_FROM || 'TLS <noreply@localhost>',
    to,
    subject,
    text,
    html: html || text,
  });
}

// ── OTP helpers ──────────────────────────────────────────────────────────────

function generateOtp() {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Stores an OTP in the database for a given purpose.
 * @param {number} userId
 * @param {'2fa_login'|'invite'} purpose
 * @returns {{ otp: string, tempToken: string }}
 */
function createOtp(userId, purpose) {
  const db = getDb();
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
 * @returns {number|null} userId on success, null on failure
 */
function verifyOtp(tempToken, otp, purpose) {
  const db   = getDb();
  const now  = Date.now();
  const rows = db.prepare(`
    SELECT id, user_id, token FROM otp_tokens
    WHERE purpose = ? AND used = 0 AND expires_at > ?
  `).all(purpose, now);

  for (const row of rows) {
    const [storedTemp, storedOtp] = row.token.split(':');
    if (storedTemp === tempToken && storedOtp === otp) {
      db.prepare('UPDATE otp_tokens SET used = 1 WHERE id = ?').run(row.id);
      return row.user_id;
    }
  }
  return null;
}

// ── Session management ───────────────────────────────────────────────────────

/**
 * Creates a new session for a user and sets the session cookie on res.
 * @returns {string} session token
 */
function createSession(userId, res) {
  const db    = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const now   = Date.now();
  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, now, now + SESSION_TTL_MS);

  res.setHeader('Set-Cookie',
    `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
  return token;
}

function destroySession(token, res) {
  if (token) {
    try { getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token); } catch { /* ignore */ }
  }
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

/**
 * Resolves a session token to a user row.
 * @returns {object|null} user row or null
 */
function resolveSession(token) {
  if (!token) return null;
  const db  = getDb();
  const now = Date.now();
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.force_password_change, u.two_fa_enabled, u.enabled
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now);
  return row || null;
}

function parseCookies(req) {
  const map = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(part => {
    const [k, ...rest] = part.split('=');
    if (k) map[k.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return map;
}

// ── Express middleware ────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const user    = resolveSession(cookies.session);
  if (!user) return res.status(401).json({ error: 'Unauthorised' });
  if (!user.enabled) return res.status(403).json({ error: 'Account disabled' });
  req.user        = user;
  req.sessionToken = cookies.session;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

// ── Cloudflare Turnstile ─────────────────────────────────────────────────────

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // Turnstile disabled in development

  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const data = await resp.json();
    return data.success === true;
  } catch (err) {
    console.error('[turnstile] verification error:', err.message);
    return false;
  }
}

module.exports = {
  createSession,
  destroySession,
  resolveSession,
  parseCookies,
  requireAuth,
  requireAdmin,
  createOtp,
  verifyOtp,
  sendMail,
  verifyTurnstile,
};
