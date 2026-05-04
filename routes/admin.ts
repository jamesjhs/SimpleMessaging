/**
 * routes/admin.ts
 * Admin API: users, reports, settings, icon upload, posts.json import, invites.
 */

import { Router, Request, Response } from 'express';
import multer                        from 'multer';
import crypto                        from 'crypto';
import path                          from 'path';
import fs                            from 'fs';
import { getDb, hashPassword, getSetting, setSetting } from '../db';
import { requireAdmin, createOtp, sendMail }           from '../lib/auth';
import { rateLimiter }                                 from '../lib/rateLimiter';
import type { DbUser }                                 from '../types';

const router  = Router();
const jsonUp  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const imageUp = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// All routes in this file require admin role, with moderate rate limiting
router.use(
  requireAdmin,
  rateLimiter({ windowMs: 60_000, max: 120 }),
);

// ── In-memory preview store for two-step import ───────────────────────────────

interface LegacyPost {
  id?:        string;
  user?:      string;
  text?:      string;
  imagePath?: string;
  viewOnce?:  boolean;
  isBlurred?: boolean;
  replyId?:   string;
  replyUser?: string;
  replyText?: string;
  createdAt?: number;
  /** Display names of users who have already viewed this view-once message */
  seenBy?:    string[];
}

const importPreviews = new Map<string, { posts: LegacyPost[]; expiresAt: number }>();

// Purge stale previews every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of importPreviews) {
    if (v.expiresAt < now) importPreviews.delete(k);
  }
}, 5 * 60_000);

// ── GET /api/admin/users ──────────────────────────────────────────────────────

router.get('/users', (_req: Request, res: Response): void => {
  const users = getDb().prepare(`
    SELECT id, username, display_name, email, role, force_password_change,
           two_fa_enabled, enabled, created_at, last_seen
    FROM users ORDER BY id
  `).all();
  res.json(users);
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────

router.post('/users', async (req: Request, res: Response): Promise<void> => {
  const { username, displayName, password, email, role } = req.body as {
    username?:    string;
    displayName?: string;
    password?:    string;
    email?:       string;
    role?:        string;
  };

  if (!username || !displayName || !password) {
    res.status(400).json({ error: 'username, displayName and password required' });
    return;
  }

  const safeRole: 'admin' | 'user' = role === 'admin' ? 'admin' : 'user';
  const db = getDb();

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) { res.status(409).json({ error: 'Username already taken' }); return; }

  const hash = await hashPassword(password);
  const info = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, email, role, force_password_change, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?)
  `).run(username, displayName, hash, email ?? null, safeRole, Date.now());

  res.status(201).json({ id: info.lastInsertRowid });
});

// ── PATCH /api/admin/users/:id ────────────────────────────────────────────────

router.patch('/users/:id', async (req: Request, res: Response): Promise<void> => {
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as DbUser | undefined;
  if (!user) { res.sendStatus(404); return; }

  const {
    displayName, email, role, enabled, twoFaEnabled,
    forcePasswordChange, newPassword, loginLocked,
  } = req.body as Record<string, unknown>;

  const updates: string[] = [];
  const vals:    unknown[] = [];

  if (displayName         !== undefined) { updates.push('display_name = ?');          vals.push(String(displayName)); }
  if (email               !== undefined) { updates.push('email = ?');                  vals.push((email as string) || null); }
  if (role                !== undefined) { updates.push('role = ?');                   vals.push(role === 'admin' ? 'admin' : 'user'); }
  if (enabled             !== undefined) { updates.push('enabled = ?');                vals.push(enabled ? 1 : 0); }
  if (twoFaEnabled        !== undefined) { updates.push('two_fa_enabled = ?');         vals.push(twoFaEnabled ? 1 : 0); }
  if (forcePasswordChange !== undefined) { updates.push('force_password_change = ?'); vals.push(forcePasswordChange ? 1 : 0); }
  if (loginLocked !== undefined) {
    updates.push('login_locked = ?');
    vals.push(loginLocked ? 1 : 0);
    if (!loginLocked) {
      // Reset failure counters when admin unlocks the account
      updates.push('failed_login_attempts = ?');
      vals.push(0);
      updates.push('locked_until = ?');
      vals.push(null);
    }
  }
  if (newPassword) {
    const hash = await hashPassword(String(newPassword));
    updates.push('password_hash = ?');
    vals.push(hash);
  }

  if (updates.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

  vals.push(req.params.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.sendStatus(204);
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────

router.delete('/users/:id', (req: Request, res: Response): void => {
  const db = getDb();

  const adminCount = (db.prepare(
    "SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND enabled = 1",
  ).get() as { c: number }).c;

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as DbUser | undefined;
  if (!target) { res.sendStatus(404); return; }

  if (target.role === 'admin' && adminCount <= 1) {
    res.status(400).json({ error: 'Cannot delete the last admin account' });
    return;
  }

  // Soft-disable rather than hard-delete to preserve message history
  db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(req.params.id);
  res.sendStatus(204);
});

// ── POST /api/admin/invite ────────────────────────────────────────────────────

router.post('/invite', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.body as { userId?: number | string };
  if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as DbUser | undefined;
  if (!user) { res.sendStatus(404); return; }
  if (!user.email) { res.status(400).json({ error: 'User has no email address' }); return; }

  const { otp: inviteCode } = createOtp(user.id, 'invite');
  const appUrl = process.env.APP_URL ?? 'http://localhost:3333';

  try {
    await sendMail(
      user.email,
      'You have been invited to TLS',
      `You have been invited to TLS secure messaging.\n\nSign in at: ${appUrl}\nUsername: ${user.username}\nTemporary code: ${inviteCode}\n\nThis code expires in 10 minutes. You will be asked to change your password on first login.`,
      `<p>You have been invited to <strong>TLS</strong> secure messaging.</p>
       <p>Sign in at: <a href="${appUrl}">${appUrl}</a><br>
       Username: <strong>${user.username}</strong><br>
       Temporary code: <strong>${inviteCode}</strong></p>
       <p>This code expires in 10&nbsp;minutes. You will be asked to set a new password on first login.</p>`,
    );
    res.json({ status: 'sent' });
  } catch (err) {
    console.error('[admin] invite email failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to send invite email' });
  }
});

// ── GET /api/admin/reports ────────────────────────────────────────────────────

router.get('/reports', (_req: Request, res: Response): void => {
  const reports = getDb().prepare(`
    SELECT r.id, r.reported_at, r.reviewed, r.action_taken,
           reporter.display_name AS reporter_name,
           reviewer.display_name AS reviewer_name,
           m.text                AS message_text,
           m.image_path,
           m.created_at          AS message_at,
           author.display_name   AS author_name
    FROM reports r
    JOIN users    reporter ON reporter.id = r.reported_by
    JOIN messages m         ON m.id        = r.message_id
    JOIN users    author   ON author.id   = m.user_id
    LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
    ORDER BY r.reported_at DESC
  `).all();
  res.json(reports);
});

// ── PATCH /api/admin/reports/:id ──────────────────────────────────────────────

router.patch('/reports/:id', (req: Request, res: Response): void => {
  const db     = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) { res.sendStatus(404); return; }

  const { actionTaken } = req.body as { actionTaken?: string };
  db.prepare(
    'UPDATE reports SET reviewed = 1, reviewed_by = ?, reviewed_at = ?, action_taken = ? WHERE id = ?',
  ).run(req.user!.id, Date.now(), actionTaken ?? 'reviewed', req.params.id);

  res.sendStatus(204);
});

// ── GET /api/admin/settings ───────────────────────────────────────────────────

router.get('/settings', (_req: Request, res: Response): void => {
  const keys = [
    'pwa_enabled',          'report_enabled',        'site_title',
    'main_header',          'enable_view_once',       'enable_blur',
    'enable_emergency_exit','enable_delete_button',   'delete_button',
    'reply_button',         'read_status_seen',       'read_status_unread',
    'chat_icon_url',
  ];
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = getSetting(k);
  res.json(out);
});

// ── PATCH /api/admin/settings ─────────────────────────────────────────────────

router.patch('/settings', (req: Request, res: Response): void => {
  const allowed = [
    'pwa_enabled',          'report_enabled',        'site_title',
    'main_header',          'enable_view_once',       'enable_blur',
    'enable_emergency_exit','enable_delete_button',   'delete_button',
    'reply_button',         'read_status_seen',       'read_status_unread',
  ];
  const body = req.body as Record<string, unknown>;
  for (const k of allowed) {
    if (k in body) setSetting(k, String(body[k]));
  }
  res.sendStatus(204);
});

// ── POST /api/admin/icon ──────────────────────────────────────────────────────

router.post('/icon', imageUp.single('icon'), (req: Request, res: Response): void => {
  if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  const mime    = req.file.mimetype.split(';')[0];
  if (!allowed.includes(mime)) { res.status(400).json({ error: 'Invalid image type' }); return; }

  const extMap: Record<string, string> = {
    'image/svg+xml': 'svg', 'image/gif': 'gif',
    'image/png': 'png',     'image/webp': 'webp',
    'image/jpeg': 'jpg',
  };
  const filename = `chat-icon.${extMap[mime] ?? 'png'}`;
  const iconPath = path.join(__dirname, '..', 'public', filename);

  try {
    fs.writeFileSync(iconPath, req.file.buffer);
    const url = `/${filename}`;
    setSetting('chat_icon_url', url);
    res.json({ url });
  } catch (err) {
    console.error('[admin] icon save failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to save icon' });
  }
});

// ── POST /api/admin/import/preview ───────────────────────────────────────────

router.post('/import/preview', jsonUp.single('file'), (req: Request, res: Response): void => {
  if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

  let posts: LegacyPost[];
  try {
    posts = JSON.parse(req.file.buffer.toString('utf8')) as LegacyPost[];
    if (!Array.isArray(posts)) throw new Error('Expected a JSON array');
  } catch (err) {
    res.status(400).json({ error: `Invalid JSON: ${(err as Error).message}` });
    return;
  }

  const db = getDb();
  const existingUsers = db.prepare(
    'SELECT id, username, display_name FROM users WHERE enabled = 1 ORDER BY display_name',
  ).all() as Array<{ id: number; username: string; display_name: string }>;

  // Build lookup map for auto-suggestions
  const nameToUser = new Map<string, { id: number; display_name: string; username: string }>();
  existingUsers.forEach(u => nameToUser.set(u.display_name.trim().toLowerCase(), u));

  // Collect all unique display names (post authors + seenBy viewers)
  const uniqueNames = new Map<string, string>(); // trimmed name → original casing
  posts.forEach(p => {
    if (p.user) uniqueNames.set(p.user.trim().toLowerCase(), p.user.trim());
    if (Array.isArray(p.seenBy)) {
      p.seenBy.forEach(n => { if (n) uniqueNames.set(n.trim().toLowerCase(), n.trim()); });
    }
  });

  const nameSuggestions = Array.from(uniqueNames.entries()).map(([key, name]) => {
    const matched = nameToUser.get(key);
    return {
      name,
      suggestedUserId:      matched?.id          ?? null,
      suggestedDisplayName: matched?.display_name ?? null,
      suggestedUsername:    matched?.username     ?? null,
    };
  });

  // Store parsed posts under a one-time token (30-minute TTL)
  const previewToken = crypto.randomUUID();
  importPreviews.set(previewToken, { posts, expiresAt: Date.now() + 30 * 60_000 });

  res.json({
    previewToken,
    postCount:    posts.length,
    uniqueNames:  nameSuggestions,
    existingUsers: existingUsers.map(u => ({ id: u.id, display_name: u.display_name, username: u.username })),
  });
});

// ── POST /api/admin/import/commit ─────────────────────────────────────────────

router.post('/import/commit', async (req: Request, res: Response): Promise<void> => {
  const { previewToken, mapping } = req.body as {
    previewToken?: string;
    mapping?: Record<string, number | null>;
  };

  if (!previewToken || !mapping) {
    res.status(400).json({ error: 'previewToken and mapping are required' });
    return;
  }

  const preview = importPreviews.get(previewToken);
  if (!preview || preview.expiresAt < Date.now()) {
    importPreviews.delete(previewToken);
    res.status(400).json({ error: 'Preview session expired. Please re-upload the file.' });
    return;
  }
  importPreviews.delete(previewToken); // single-use

  const db = getDb();

  // Build trimmed-name → userId from the admin's mapping.
  // Entries where userId is null trigger auto-creation of a stub account.
  const nameToUserId = new Map<string, number>(); // trimmed original-case name → userId
  const created: Array<{ displayName: string; username: string; temporaryPassword: string }> = [];

  for (const [importedName, userId] of Object.entries(mapping)) {
    const trimmed = importedName.trim();
    if (userId !== null && userId !== undefined && Number.isInteger(Number(userId))) {
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
      if (user) nameToUserId.set(trimmed, Number(userId));
    } else {
      // Auto-create a stub user for this display name
      const base    = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase().slice(0, 28);
      let username  = `${base}_imported`;
      let attempt   = 0;
      while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        attempt++;
        username = `${base}_imported_${attempt}`;
      }
      const password = crypto.randomBytes(8).toString('hex');
      const hash     = await hashPassword(password);
      try {
        const info = db.prepare(`
          INSERT INTO users (username, display_name, password_hash, role, force_password_change, enabled, created_at)
          VALUES (?, ?, ?, 'user', 1, 1, ?)
        `).run(username, trimmed, hash, Date.now());
        const newId = Number(info.lastInsertRowid);
        nameToUserId.set(trimmed, newId);
        created.push({ displayName: trimmed, username, temporaryPassword: password });
      } catch { /* skip if creation fails */ }
    }
  }

  // Also populate from existing users by display name (for seenBy names that
  // may not have appeared as post authors and thus have no mapping entry)
  (db.prepare('SELECT id, display_name FROM users').all() as Array<{ id: number; display_name: string }>)
    .forEach(u => {
      const t = u.display_name.trim();
      if (!nameToUserId.has(t)) nameToUserId.set(t, u.id);
    });

  const posts    = preview.posts;
  let imported   = 0;
  let skipped    = 0;

  for (const p of posts) {
    if (!p?.user) { skipped++; continue; }

    const userId = nameToUserId.get(p.user.trim());
    if (!userId) { skipped++; continue; }

    if (p.id) {
      const exists = db.prepare('SELECT id FROM messages WHERE id = ?').get(p.id);
      if (exists) { skipped++; continue; }
    }

    const msgId = p.id ?? crypto.randomUUID();
    try {
      db.prepare(`
        INSERT INTO messages
          (id, user_id, text, image_path, view_once, is_blurred,
           reply_to_id, reply_user, reply_text, created_at, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        msgId, userId,
        p.text      ?? '',
        p.imagePath ?? null,
        p.viewOnce  ? 1 : 0,
        p.isBlurred ? 1 : 0,
        p.replyId   ?? null,
        p.replyUser ?? null,
        p.replyText ?? null,
        p.createdAt ?? Date.now(),
        p.createdAt ?? null,
      );
      imported++;

      // Restore view-once seen state using the same name→userId mapping
      if (p.viewOnce && Array.isArray(p.seenBy) && p.seenBy.length > 0) {
        for (const viewerName of p.seenBy) {
          const viewerUserId = nameToUserId.get(viewerName.trim());
          if (viewerUserId) {
            try {
              db.prepare(
                'INSERT OR IGNORE INTO message_views (message_id, user_id, viewed_at) VALUES (?, ?, ?)',
              ).run(msgId, viewerUserId, p.createdAt ?? Date.now());
            } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      console.warn('[import] failed row:', (err as Error).message);
      skipped++;
    }
  }

  res.json({ imported, skipped, createdUsers: created });
});

export default router;
