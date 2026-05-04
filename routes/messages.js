'use strict';

/**
 * routes/messages.js
 * Chat messages, typing indicator, view-once, reports, user preferences, and public config.
 */

const express  = require('express');
const multer   = require('multer');
const sharp    = require('sharp');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { getDb, getSetting } = require('../db');
const { requireAuth }       = require('../lib/auth');

const router     = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// In-memory typing state (transient, no need to persist)
const typingUsers = new Map(); // displayName -> timestamp

// ── Multer configuration ─────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime',
    ];
    const baseMime = file.mimetype.split(';')[0];
    if (allowed.includes(baseMime)) return cb(null, true);
    console.warn('[upload] rejected:', file.mimetype);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Invalid file type'));
  },
});

// ── Helper: convert DB row → API post object ─────────────────────────────────

function rowToPost(row, viewerUserId) {
  const db = getDb();

  const seenBy = db.prepare(`
    SELECT u.display_name FROM message_views mv
    JOIN users u ON u.id = mv.user_id
    WHERE mv.message_id = ?
  `).all(row.id).map(r => r.display_name);

  return {
    id:        row.id,
    user:      row.display_name,
    text:      row.text || '',
    imagePath: row.image_path || null,
    viewOnce:  row.view_once  === 1,
    isBlurred: row.is_blurred === 1,
    createdAt: row.created_at,
    seenBy,
    replyUser: row.reply_user  || null,
    replyText: row.reply_text  || null,
    replyId:   row.reply_to_id || null,
  };
}

// ── GET /api/me ───────────────────────────────────────────────────────────────

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user:               req.user.display_name,
    role:               req.user.role,
    forcePasswordChange: req.user.force_password_change === 1,
    twoFaEnabled:        req.user.two_fa_enabled === 1,
  });
});

// ── GET /api/config ───────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  res.json({
    siteTitle:            getSetting('site_title')           || 'TLS',
    mainHeader:           getSetting('main_header')          || 'TLS',
    readStatusSeen:       getSetting('read_status_seen')     || '✓✓',
    readStatusUnread:     getSetting('read_status_unread')   || '✓',
    deleteButton:         getSetting('delete_button')        || '✗',
    replyButton:          getSetting('reply_button')         || '↩',
    enableDeleteButton:   getSetting('enable_delete_button') !== '0',
    enableViewOnce:       getSetting('enable_view_once')     !== '0',
    enableBlur:           getSetting('enable_blur')          !== '0',
    enableEmergencyExit:  getSetting('enable_emergency_exit') !== '0',
    enableReport:         getSetting('report_enabled')       === '1',
    pwaEnabled:           getSetting('pwa_enabled')          === '1',
    turnstileSiteKey:     process.env.TURNSTILE_SITE_KEY     || null,
  });
});

// ── GET /api/messages ─────────────────────────────────────────────────────────

router.get('/messages', requireAuth, (req, res) => {
  const db  = getDb();
  const now = Date.now();

  // Update last_seen for active users
  if (req.query.active !== 'false') {
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, req.user.id);
  }

  // Prune stale typing entries (> 5 s)
  for (const [name, ts] of typingUsers) {
    if (now - ts > 5000) typingUsers.delete(name);
  }

  const limit  = parseInt(req.query.limit, 10) || 50;
  const before = req.query.before ? parseInt(req.query.before, 10) : null;

  let rows;
  if (before) {
    rows = db.prepare(`
      SELECT m.*, u.display_name FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.deleted_at IS NULL AND m.created_at < ?
      ORDER BY m.created_at DESC LIMIT ?
    `).all(before, limit).reverse();
  } else {
    rows = db.prepare(`
      SELECT m.*, u.display_name FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.deleted_at IS NULL
      ORDER BY m.created_at DESC LIMIT ?
    `).all(limit).reverse();
  }

  // Build lastSeen map for all users
  const userRows = db.prepare('SELECT display_name, last_seen FROM users WHERE last_seen IS NOT NULL').all();
  const lastSeen = {};
  for (const u of userRows) lastSeen[u.display_name] = u.last_seen;

  // Typing (exclude self)
  const typing = [...typingUsers.keys()].filter(n => n !== req.user.display_name);

  const posts = rows.map(r => rowToPost(r, req.user.id));

  res.json({ posts, total: posts.length, typing, lastSeen });
});

// ── POST /api/messages ────────────────────────────────────────────────────────

router.post('/messages', requireAuth, upload.single('image'), async (req, res) => {
  const { text, viewOnce, isBlurred, replyUser, replyText, replyId, submittedAt } = req.body || {};
  const hasText  = text && text.trim() !== '';
  const hasMedia = !!req.file;

  if (!hasText && !hasMedia) {
    return res.status(400).json({ error: 'Post content required' });
  }

  let imagePath = null;

  if (req.file) {
    const baseMime = req.file.mimetype.split(';')[0];
    const isVideo  = baseMime.startsWith('video/');
    const ext      = isVideo
      ? (baseMime.includes('webm') || baseMime.includes('matroska') ? '.webm' : '.mp4')
      : '.jpg';
    const filename = `${crypto.randomUUID()}${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);

    try {
      if (isVideo) {
        fs.writeFileSync(filepath, req.file.buffer);
      } else {
        await sharp(req.file.buffer)
          .rotate()
          .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
          .toFormat('jpeg')
          .jpeg({ quality: 85 })
          .withMetadata()
          .toFile(filepath);
      }
      imagePath = `/uploads/${filename}`;
    } catch (err) {
      console.error('[upload] processing error:', err.message);
      return res.status(500).json({ error: 'Media processing failed' });
    }
  }

  const now         = Date.now();
  const clientTime  = parseInt(submittedAt, 10);
  const createdAt   = Number.isFinite(clientTime) && Math.abs(clientTime - now) < 5 * 60 * 1000
    ? clientTime : now;

  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO messages
      (id, user_id, text, image_path, view_once, is_blurred, reply_to_id, reply_user, reply_text, created_at, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.user.id,
    text ? text.trim() : '',
    imagePath,
    viewOnce === 'true' ? 1 : 0,
    isBlurred === 'true' ? 1 : 0,
    replyId && replyId !== 'undefined' ? replyId : null,
    replyUser || null,
    replyText || null,
    createdAt,
    parseInt(submittedAt, 10) || now
  );

  res.status(201).json({ success: true });
});

// ── DELETE /api/messages/:id ─────────────────────────────────────────────────

router.delete('/messages/:id', requireAuth, (req, res) => {
  const db  = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.sendStatus(404);

  // Own messages or admin can delete
  if (msg.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.sendStatus(403);
  }

  // Soft-delete: mark as deleted but keep media on disk for audit
  db.prepare('UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?')
    .run(Date.now(), req.user.id, req.params.id);

  res.sendStatus(204);
});

// ── POST /api/messages/:id/view (view-once) ───────────────────────────────────

router.post('/messages/:id/view', requireAuth, (req, res) => {
  const db  = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!msg) return res.sendStatus(404);

  if (msg.view_once) {
    try {
      db.prepare('INSERT OR IGNORE INTO message_views (message_id, user_id, viewed_at) VALUES (?, ?, ?)')
        .run(msg.id, req.user.id, Date.now());
    } catch { /* duplicate view – ignore */ }
  }

  res.json({ imagePath: msg.image_path });
});

// ── POST /api/messages/:id/report ────────────────────────────────────────────

router.post('/messages/:id/report', requireAuth, (req, res) => {
  if (getSetting('report_enabled') !== '1') {
    return res.status(403).json({ error: 'Reporting is not enabled' });
  }

  const db  = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!msg) return res.sendStatus(404);
  if (msg.user_id === req.user.id) return res.status(400).json({ error: 'Cannot report your own message' });

  // Prevent duplicate reports from same user
  const existing = db.prepare('SELECT id FROM reports WHERE message_id = ? AND reported_by = ? AND reviewed = 0').get(msg.id, req.user.id);
  if (existing) return res.status(409).json({ error: 'Already reported' });

  db.prepare('INSERT INTO reports (message_id, reported_by, reported_at) VALUES (?, ?, ?)')
    .run(msg.id, req.user.id, Date.now());

  res.json({ status: 'reported' });
});

// ── POST /api/typing ──────────────────────────────────────────────────────────

router.post('/typing', requireAuth, (req, res) => {
  const { isTyping } = req.body || {};
  if (isTyping) typingUsers.set(req.user.display_name, Date.now());
  else          typingUsers.delete(req.user.display_name);
  res.sendStatus(204);
});

// ── GET /api/preferences ──────────────────────────────────────────────────────

router.get('/preferences', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(req.user.id);
  res.json({
    scheme:      row?.colour_scheme || 'default',
    enterToSend: row?.enter_to_send === 1,
  });
});

// ── POST /api/preferences ─────────────────────────────────────────────────────

router.post('/preferences', requireAuth, (req, res) => {
  const { scheme, enterToSend } = req.body || {};
  const db  = getDb();
  const now = Date.now();
  const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(req.user.id);

  if (row) {
    const updates = [];
    const vals    = [];
    if (scheme      !== undefined) { updates.push('colour_scheme = ?'); vals.push(String(scheme)); }
    if (enterToSend !== undefined) { updates.push('enter_to_send = ?'); vals.push(enterToSend ? 1 : 0); }
    updates.push('updated_at = ?'); vals.push(now);
    vals.push(req.user.id);
    if (updates.length > 1) db.prepare(`UPDATE user_preferences SET ${updates.join(', ')} WHERE user_id = ?`).run(...vals);
  } else {
    db.prepare('INSERT INTO user_preferences (user_id, colour_scheme, enter_to_send, updated_at) VALUES (?, ?, ?, ?)')
      .run(req.user.id, scheme || 'default', enterToSend ? 1 : 0, now);
  }

  res.sendStatus(204);
});

// ── Multer error handler ──────────────────────────────────────────────────────

router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 50 MB)' });
    return res.status(400).json({ error: err.message });
  }
  console.error('[messages] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = router;
