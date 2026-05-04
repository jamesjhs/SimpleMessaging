/**
 * routes/messages.ts
 * Chat messages, typing indicator, view-once, reports, user preferences, and public config.
 */

import { Router, Request, Response }    from 'express';
import multer, { MulterError }          from 'multer';
import sharp                            from 'sharp';
import path                             from 'path';
import fs                               from 'fs';
import crypto                           from 'crypto';
import { getDb, getSetting }            from '../db';
import { requireAuth }                  from '../lib/auth';
import { rateLimiter }                  from '../lib/rateLimiter';
import type { DbMessage, ApiPost }      from '../types';

const router      = Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// In-memory typing state (transient – not persisted)
const typingUsers = new Map<string, number>(); // displayName → timestamp

// ── Multer configuration ──────────────────────────────────────────────────────

const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4',  'video/webm', 'video/x-matroska', 'video/quicktime',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const baseMime = file.mimetype.split(';')[0];
    if (ALLOWED_MIMES.has(baseMime)) return cb(null, true);
    console.warn('[upload] rejected mime type:', file.mimetype);
    cb(new MulterError('LIMIT_UNEXPECTED_FILE', 'Invalid file type'));
  },
});

// ── Helper: DB row → API post object ─────────────────────────────────────────

function rowToPost(row: DbMessage): ApiPost {
  const db = getDb();

  const seenBy = (db.prepare(`
    SELECT u.display_name FROM message_views mv
    JOIN users u ON u.id = mv.user_id
    WHERE mv.message_id = ? AND u.role != 'admin'
  `).all(row.id) as Array<{ display_name: string }>).map(r => r.display_name);

  const reactionRows = db.prepare(`
    SELECT r.emoji, u.display_name FROM message_reactions r
    JOIN users u ON u.id = r.user_id
    WHERE r.message_id = ?
    ORDER BY r.created_at
  `).all(row.id) as Array<{ emoji: string; display_name: string }>;

  const reactionsMap = new Map<string, string[]>();
  for (const r of reactionRows) {
    const users = reactionsMap.get(r.emoji) ?? [];
    users.push(r.display_name);
    reactionsMap.set(r.emoji, users);
  }
  const reactions = [...reactionsMap.entries()].map(([emoji, users]) => ({ emoji, users }));

  return {
    id:        row.id,
    user:      row.display_name ?? '',
    text:      row.text ?? '',
    imagePath: row.image_path ?? null,
    viewOnce:  row.view_once  === 1,
    isBlurred: row.is_blurred === 1,
    createdAt: row.created_at,
    seenBy,
    replyUser: row.reply_user  ?? null,
    replyText: row.reply_text  ?? null,
    replyId:   row.reply_to_id ?? null,
    reactions,
  };
}

// ── GET /api/me ───────────────────────────────────────────────────────────────

router.get('/me', requireAuth, (req: Request, res: Response): void => {
  res.json({
    user:                req.user!.display_name,
    role:                req.user!.role,
    forcePasswordChange: req.user!.force_password_change === 1,
    twoFaEnabled:        req.user!.two_fa_enabled         === 1,
  });
});

// ── GET /api/config ───────────────────────────────────────────────────────────

router.get('/config', (_req: Request, res: Response): void => {
  res.json({
    siteTitle:           getSetting('site_title')            ?? 'TLS',
    mainHeader:          getSetting('main_header')           ?? 'TLS',
    readStatusSeen:      getSetting('read_status_seen')      ?? '✓✓',
    readStatusUnread:    getSetting('read_status_unread')    ?? '✓',
    deleteButton:        getSetting('delete_button')         ?? '✗',
    replyButton:         getSetting('reply_button')          ?? '↩',
    enableDeleteButton:  getSetting('enable_delete_button') !== '0',
    enableViewOnce:      getSetting('enable_view_once')     !== '0',
    enableBlur:          getSetting('enable_blur')          !== '0',
    enableEmergencyExit: getSetting('enable_emergency_exit') !== '0',
    enableReport:        getSetting('report_enabled')        === '1',
    pwaEnabled:          getSetting('pwa_enabled')           === '1',
    turnstileSiteKey:    process.env.TURNSTILE_SITE_KEY      ?? null,
    chatIconUrl:         getSetting('chat_icon_url')         ?? null,
  });
});

// ── GET /api/messages ─────────────────────────────────────────────────────────

router.get('/messages', requireAuth, (req: Request, res: Response): void => {
  const db  = getDb();
  const now = Date.now();

  if (req.query.active !== 'false' && req.user!.role !== 'admin') {
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, req.user!.id);
  }

  // Prune stale typing entries (> 5 s)
  for (const [name, ts] of typingUsers) {
    if (now - ts > 5000) typingUsers.delete(name);
  }

  const limit  = parseInt(String(req.query.limit  ?? '50'), 10);
  const before = req.query.before ? parseInt(String(req.query.before), 10) : null;

  const rows: DbMessage[] = before
    ? (db.prepare(`
        SELECT m.*, u.display_name FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.deleted_at IS NULL AND m.created_at < ?
        ORDER BY m.created_at DESC LIMIT ?
      `).all(before, limit) as DbMessage[]).reverse()
    : (db.prepare(`
        SELECT m.*, u.display_name FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.deleted_at IS NULL
        ORDER BY m.created_at DESC LIMIT ?
      `).all(limit) as DbMessage[]).reverse();

  const userRows = db.prepare(
    `SELECT display_name, last_seen FROM users WHERE last_seen IS NOT NULL AND role != 'admin'`,
  ).all() as Array<{ display_name: string; last_seen: number }>;

  const lastSeen: Record<string, number> = {};
  for (const u of userRows) lastSeen[u.display_name] = u.last_seen;

  const typing = [...typingUsers.keys()].filter(n => n !== req.user!.display_name);
  const posts  = rows.map(rowToPost);

  res.json({ posts, total: posts.length, typing, lastSeen });
});

// ── POST /api/messages ────────────────────────────────────────────────────────

router.post(
  '/messages',
  requireAuth,
  rateLimiter({ windowMs: 60_000, max: 30, message: 'Sending too fast. Please slow down.' }),
  upload.single('image'),
  async (req: Request, res: Response): Promise<void> => {
    if (req.user!.role === 'admin') {
      res.status(403).json({ error: 'Administrators cannot send chat messages' });
      return;
    }

    const { text, viewOnce, isBlurred, replyUser, replyText, replyId, submittedAt } =
      req.body as Record<string, string | undefined>;

    const hasText  = !!text && text.trim() !== '';
    const hasMedia = !!req.file;

    if (!hasText && !hasMedia) {
      res.status(400).json({ error: 'Post content required' });
      return;
    }

    let imagePath: string | null = null;

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
        console.error('[upload] processing error:', (err as Error).message);
        res.status(500).json({ error: 'Media processing failed' });
        return;
      }
    }

    const now        = Date.now();
    const clientTime = parseInt(submittedAt ?? '', 10);
    const createdAt  = Number.isFinite(clientTime) && Math.abs(clientTime - now) < 5 * 60 * 1000
      ? clientTime
      : now;

    const id = crypto.randomUUID();
    getDb().prepare(`
      INSERT INTO messages
        (id, user_id, text, image_path, view_once, is_blurred,
         reply_to_id, reply_user, reply_text, created_at, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      req.user!.id,
      text?.trim() ?? '',
      imagePath,
      viewOnce  === 'true' ? 1 : 0,
      isBlurred === 'true' ? 1 : 0,
      (replyId && replyId !== 'undefined') ? replyId : null,
      replyUser ?? null,
      replyText ?? null,
      createdAt,
      parseInt(submittedAt ?? '', 10) || now,
    );

    res.status(201).json({ success: true });
  },
);

// ── DELETE /api/messages/:id ──────────────────────────────────────────────────

router.delete('/messages/:id', requireAuth, (req: Request, res: Response): void => {
  const db  = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as DbMessage | undefined;
  if (!msg) { res.sendStatus(404); return; }

  if (msg.user_id !== req.user!.id && req.user!.role !== 'admin') {
    res.sendStatus(403);
    return;
  }

  // Soft-delete – content and media path are retained for audit purposes
  db.prepare('UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?')
    .run(Date.now(), req.user!.id, req.params.id);

  res.sendStatus(204);
});

// ── POST /api/messages/:id/view  (view-once) ─────────────────────────────────

router.post('/messages/:id/view', requireAuth, (req: Request, res: Response): void => {
  if (req.user!.role === 'admin') {
    res.status(403).json({ error: 'Administrators cannot mark messages as viewed' });
    return;
  }

  const db  = getDb();
  const msg = db.prepare(
    'SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL',
  ).get(req.params.id) as DbMessage | undefined;

  if (!msg) { res.sendStatus(404); return; }

  if (msg.view_once) {
    try {
      db.prepare('INSERT OR IGNORE INTO message_views (message_id, user_id, viewed_at) VALUES (?, ?, ?)')
        .run(msg.id, req.user!.id, Date.now());
    } catch { /* duplicate view – ignore */ }
  }

  res.json({ imagePath: msg.image_path });
});

// ── POST /api/messages/:id/report ────────────────────────────────────────────

router.post('/messages/:id/report', requireAuth, (req: Request, res: Response): void => {
  if (getSetting('report_enabled') !== '1') {
    res.status(403).json({ error: 'Reporting is not enabled' });
    return;
  }

  const db  = getDb();
  const msg = db.prepare(
    'SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL',
  ).get(req.params.id) as DbMessage | undefined;

  if (!msg) { res.sendStatus(404); return; }
  if (msg.user_id === req.user!.id) {
    res.status(400).json({ error: 'Cannot report your own message' });
    return;
  }

  const existing = db.prepare(
    'SELECT id FROM reports WHERE message_id = ? AND reported_by = ? AND reviewed = 0',
  ).get(msg.id, req.user!.id) as { id: number } | undefined;

  if (existing) { res.status(409).json({ error: 'Already reported' }); return; }

  db.prepare('INSERT INTO reports (message_id, reported_by, reported_at) VALUES (?, ?, ?)')
    .run(msg.id, req.user!.id, Date.now());

  res.json({ status: 'reported' });
});

// ── POST /api/typing ──────────────────────────────────────────────────────────

router.post('/typing', requireAuth, (req: Request, res: Response): void => {
  if (req.user!.role === 'admin') {
    res.sendStatus(204);
    return;
  }
  const { isTyping } = req.body as { isTyping?: boolean };
  if (isTyping) typingUsers.set(req.user!.display_name, Date.now());
  else          typingUsers.delete(req.user!.display_name);
  res.sendStatus(204);
});

// ── GET /api/preferences ──────────────────────────────────────────────────────

router.get('/preferences', requireAuth, (req: Request, res: Response): void => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?')
    .get(req.user!.id) as { colour_scheme: string | null; enter_to_send: 0 | 1; font_size: number | null } | undefined;

  res.json({
    scheme:      row?.colour_scheme ?? 'default',
    enterToSend: row?.enter_to_send === 1,
    fontSize:    row?.font_size ?? 15,
  });
});

// ── POST /api/preferences ─────────────────────────────────────────────────────

router.post('/preferences', requireAuth, (req: Request, res: Response): void => {
  const { scheme, enterToSend, fontSize } = req.body as {
    scheme?:      string;
    enterToSend?: boolean;
    fontSize?:    number;
  };

  if (fontSize !== undefined) {
    const size = Math.round(Number(fontSize));
    if (!Number.isFinite(size) || size < 11 || size > 24) {
      res.status(400).json({ error: 'fontSize must be an integer between 11 and 24' });
      return;
    }
  }

  const db  = getDb();
  const now = Date.now();
  const row = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(req.user!.id);

  if (row) {
    const updates: string[] = [];
    const vals:    unknown[] = [];
    if (scheme      !== undefined) { updates.push('colour_scheme = ?'); vals.push(String(scheme)); }
    if (enterToSend !== undefined) { updates.push('enter_to_send = ?'); vals.push(enterToSend ? 1 : 0); }
    if (fontSize    !== undefined) { updates.push('font_size = ?');     vals.push(Math.round(Number(fontSize))); }
    if (updates.length > 0) {
      updates.push('updated_at = ?');
      vals.push(now, req.user!.id);
      db.prepare(`UPDATE user_preferences SET ${updates.join(', ')} WHERE user_id = ?`).run(...vals);
    }
  } else {
    db.prepare(
      'INSERT INTO user_preferences (user_id, colour_scheme, enter_to_send, font_size, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(req.user!.id, scheme ?? 'default', enterToSend ? 1 : 0, fontSize !== undefined ? Math.round(Number(fontSize)) : null, now);
  }

  res.sendStatus(204);
});

// ── POST /api/messages/:id/react ─────────────────────────────────────────────

const ALLOWED_REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '😡']);

router.post('/messages/:id/react', requireAuth, (req: Request, res: Response): void => {
  const { emoji } = req.body as { emoji?: string };

  if (!emoji || typeof emoji !== 'string') {
    res.status(400).json({ error: 'emoji required' });
    return;
  }
  if (!ALLOWED_REACTION_EMOJIS.has(emoji)) {
    res.status(400).json({ error: 'Invalid emoji' });
    return;
  }

  const db  = getDb();
  const msg = db.prepare(
    'SELECT id FROM messages WHERE id = ? AND deleted_at IS NULL',
  ).get(req.params.id) as { id: string } | undefined;

  if (!msg) { res.sendStatus(404); return; }

  db.prepare(`
    INSERT OR REPLACE INTO message_reactions (message_id, user_id, emoji, created_at)
    VALUES (?, ?, ?, ?)
  `).run(req.params.id, req.user!.id, emoji, Date.now());

  res.sendStatus(204);
});

// ── DELETE /api/messages/:id/react ───────────────────────────────────────────

router.delete('/messages/:id/react', requireAuth, (req: Request, res: Response): void => {
  const { emoji } = req.body as { emoji?: string };

  if (!emoji || typeof emoji !== 'string' || !ALLOWED_REACTION_EMOJIS.has(emoji)) {
    res.status(400).json({ error: 'Valid emoji required' });
    return;
  }

  const db  = getDb();
  const msg = db.prepare(
    'SELECT id FROM messages WHERE id = ? AND deleted_at IS NULL',
  ).get(req.params.id) as { id: string } | undefined;

  if (!msg) { res.sendStatus(404); return; }

  db.prepare(
    'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
  ).run(req.params.id, req.user!.id, emoji);

  res.sendStatus(204);
});

// ── Multer error handler ──────────────────────────────────────────────────────

router.use((err: unknown, _req: Request, res: Response, _next: () => void): void => {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File too large (max 50 MB)' });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  console.error('[messages] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default router;
