'use strict';

/**
 * routes/admin.js
 * Admin API: users, reports, settings, posts.json import, invites.
 */

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const crypto     = require('crypto');
const { getDb, hashPassword, getSetting, setSetting } = require('../db');
const { requireAdmin, createOtp, sendMail }            = require('../lib/auth');

const router  = express.Router();
const jsonUp  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// All admin routes require admin role
router.use(requireAdmin);

// ── GET /api/admin/users ──────────────────────────────────────────────────────

router.get('/users', (req, res) => {
  const users = getDb().prepare(`
    SELECT id, username, display_name, email, role, force_password_change,
           two_fa_enabled, enabled, created_at, last_seen
    FROM users ORDER BY id
  `).all();
  res.json(users);
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────

router.post('/users', async (req, res) => {
  const { username, displayName, password, email, role } = req.body || {};
  if (!username || !displayName || !password) {
    return res.status(400).json({ error: 'username, displayName and password required' });
  }
  const safeRole = role === 'admin' ? 'admin' : 'user';
  const db = getDb();

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const hash = await hashPassword(password);
  const info = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, email, role, force_password_change, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?)
  `).run(username, displayName, hash, email || null, safeRole, Date.now());

  res.status(201).json({ id: info.lastInsertRowid });
});

// ── PATCH /api/admin/users/:id ────────────────────────────────────────────────

router.patch('/users/:id', async (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.sendStatus(404);

  const { displayName, email, role, enabled, twoFaEnabled, forcePasswordChange, newPassword } = req.body || {};
  const updates = [];
  const vals    = [];

  if (displayName        !== undefined) { updates.push('display_name = ?');          vals.push(String(displayName)); }
  if (email              !== undefined) { updates.push('email = ?');                  vals.push(email || null); }
  if (role               !== undefined) { updates.push('role = ?');                   vals.push(role === 'admin' ? 'admin' : 'user'); }
  if (enabled            !== undefined) { updates.push('enabled = ?');                vals.push(enabled ? 1 : 0); }
  if (twoFaEnabled       !== undefined) { updates.push('two_fa_enabled = ?');         vals.push(twoFaEnabled ? 1 : 0); }
  if (forcePasswordChange !== undefined) { updates.push('force_password_change = ?'); vals.push(forcePasswordChange ? 1 : 0); }
  if (newPassword) {
    const hash = await hashPassword(newPassword);
    updates.push('password_hash = ?');
    vals.push(hash);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  vals.push(req.params.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals);

  res.sendStatus(204);
});

// ── DELETE /api/admin/users/:id ────────────────────────────────────────────────

router.delete('/users/:id', (req, res) => {
  const db = getDb();
  // Protect last admin
  const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND enabled = 1").get().c;
  const target     = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.sendStatus(404);
  if (target.role === 'admin' && adminCount <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin account' });
  }
  db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(req.params.id);
  res.sendStatus(204);
});

// ── POST /api/admin/invite ────────────────────────────────────────────────────

router.post('/invite', async (req, res) => {
  const db       = getDb();
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.sendStatus(404);
  if (!user.email) return res.status(400).json({ error: 'User has no email address' });

  const { otp: inviteCode } = createOtp(user.id, 'invite');
  const appUrl = process.env.APP_URL || 'http://localhost:3333';

  try {
    await sendMail(
      user.email,
      'You have been invited to TLS',
      `You have been invited to TLS secure messaging.\n\nSign in at: ${appUrl}\nUsername: ${user.username}\nTemporary code: ${inviteCode}\n\nThis code expires in 10 minutes. You will be asked to change your password on first login.`,
      `<p>You have been invited to <strong>TLS</strong> secure messaging.</p>
       <p>Sign in at: <a href="${appUrl}">${appUrl}</a><br>
       Username: <strong>${user.username}</strong><br>
       Temporary code: <strong>${inviteCode}</strong></p>
       <p>This code expires in 10 minutes. You will be asked to set a new password on first login.</p>`
    );
    res.json({ status: 'sent' });
  } catch (err) {
    console.error('[admin] invite email failed:', err.message);
    res.status(500).json({ error: 'Failed to send invite email' });
  }
});

// ── GET /api/admin/reports ────────────────────────────────────────────────────

router.get('/reports', (req, res) => {
  const db      = getDb();
  const reports = db.prepare(`
    SELECT r.id, r.reported_at, r.reviewed, r.action_taken,
           reporter.display_name AS reporter_name,
           reviewer.display_name AS reviewer_name,
           m.text AS message_text, m.image_path, m.created_at AS message_at,
           author.display_name AS author_name
    FROM reports r
    JOIN users   reporter ON reporter.id = r.reported_by
    JOIN messages m        ON m.id        = r.message_id
    JOIN users   author   ON author.id   = m.user_id
    LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
    ORDER BY r.reported_at DESC
  `).all();
  res.json(reports);
});

// ── PATCH /api/admin/reports/:id ──────────────────────────────────────────────

router.patch('/reports/:id', (req, res) => {
  const db     = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.sendStatus(404);

  const { actionTaken } = req.body || {};
  db.prepare('UPDATE reports SET reviewed = 1, reviewed_by = ?, reviewed_at = ?, action_taken = ? WHERE id = ?')
    .run(req.user.id, Date.now(), actionTaken || 'reviewed', req.params.id);

  res.sendStatus(204);
});

// ── GET /api/admin/settings ───────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  const keys = [
    'pwa_enabled', 'report_enabled', 'site_title', 'main_header',
    'enable_view_once', 'enable_blur', 'enable_emergency_exit',
    'enable_delete_button', 'delete_button', 'reply_button',
    'read_status_seen', 'read_status_unread',
  ];
  const out = {};
  for (const k of keys) out[k] = getSetting(k);
  res.json(out);
});

// ── PATCH /api/admin/settings ─────────────────────────────────────────────────

router.patch('/settings', (req, res) => {
  const allowed = [
    'pwa_enabled', 'report_enabled', 'site_title', 'main_header',
    'enable_view_once', 'enable_blur', 'enable_emergency_exit',
    'enable_delete_button', 'delete_button', 'reply_button',
    'read_status_seen', 'read_status_unread',
  ];
  const body = req.body || {};
  for (const k of allowed) {
    if (k in body) setSetting(k, String(body[k]));
  }
  res.sendStatus(204);
});

// ── POST /api/admin/import ────────────────────────────────────────────────────
// Imports historical messages from a posts.json file.
// Auto-matches display names to existing users; creates stub users for unmatched names.

router.post('/import', jsonUp.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let posts;
  try {
    posts = JSON.parse(req.file.buffer.toString('utf8'));
    if (!Array.isArray(posts)) throw new Error('Expected a JSON array');
  } catch (err) {
    return res.status(400).json({ error: `Invalid JSON: ${err.message}` });
  }

  const db       = getDb();
  const userCache = new Map(); // displayName -> userId
  let imported   = 0;
  let skipped    = 0;
  const created  = [];

  // Pre-load existing users into cache
  db.prepare('SELECT id, display_name FROM users').all()
    .forEach(u => userCache.set(u.display_name.toLowerCase(), u.id));

  for (const p of posts) {
    if (!p || !p.user) { skipped++; continue; }

    // Resolve or create user
    const nameKey = p.user.toLowerCase();
    let userId = userCache.get(nameKey);
    if (!userId) {
      // Create stub user
      const stub = p.user.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase().slice(0, 30);
      const username = `${stub}_imported`;
      const password = crypto.randomBytes(8).toString('hex');
      const hash     = await hashPassword(password);
      try {
        const info = db.prepare(`
          INSERT INTO users (username, display_name, password_hash, role, force_password_change, enabled, created_at)
          VALUES (?, ?, ?, 'user', 1, 1, ?)
        `).run(username, p.user, hash, Date.now());
        userId = info.lastInsertRowid;
        userCache.set(nameKey, userId);
        created.push({ displayName: p.user, username, temporaryPassword: password });
      } catch {
        skipped++;
        continue;
      }
    }

    // Skip if already imported (idempotent by original id)
    if (p.id) {
      const exists = db.prepare('SELECT id FROM messages WHERE id = ?').get(p.id);
      if (exists) { skipped++; continue; }
    }

    const msgId = p.id || crypto.randomUUID();
    try {
      db.prepare(`
        INSERT INTO messages
          (id, user_id, text, image_path, view_once, is_blurred, reply_to_id, reply_user, reply_text, created_at, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        msgId,
        userId,
        p.text || '',
        p.imagePath || null,
        p.viewOnce  ? 1 : 0,
        p.isBlurred ? 1 : 0,
        p.replyId   || null,
        p.replyUser || null,
        p.replyText || null,
        p.createdAt || Date.now(),
        p.createdAt || null
      );
      imported++;
    } catch (err) {
      console.warn('[import] failed row:', err.message);
      skipped++;
    }
  }

  res.json({ imported, skipped, createdUsers: created });
});

module.exports = router;
