/**
 * db.ts
 * Opens the SQLCipher-encrypted SQLite database, runs schema migrations,
 * seeds the initial admin user, and exposes typed helper functions.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import type { Database as DB } from 'better-sqlite3';
import path from 'path';
import fs   from 'fs';
import crypto from 'crypto';
import type { DbUser, DbUserPreferences } from './types';

let db: DB | null = null;

/**
 * Derives a 32-byte AES key from an arbitrary passphrase using PBKDF2-SHA256.
 * Using PBKDF2 rather than a bare hash makes brute-force attacks significantly harder.
 * The salt is fixed (non-secret); security derives from the passphrase remaining secret.
 */
function deriveDbKey(passphrase: string): string {
  const salt = Buffer.from('tls-db-key-v1', 'utf8');
  return crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256').toString('hex');
}

/**
 * Opens (or creates) the encrypted database, applies schema migrations,
 * and seeds the initial admin account from environment variables.
 */
export async function initDb(): Promise<DB> {
  const dbPath = path.resolve(process.env.DB_PATH ?? './data/tls.db');
  const dbDir  = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const passphrase = process.env.DB_ENCRYPTION_KEY;
  if (!passphrase) throw new Error('DB_ENCRYPTION_KEY is required in .env');

  db = new Database(dbPath);

  // Apply SQLCipher encryption – must be the very first pragmas executed
  const hexKey = deriveDbKey(passphrase);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${hexKey}'"`);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── Schema ────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      username              TEXT    UNIQUE NOT NULL COLLATE NOCASE,
      display_name          TEXT    NOT NULL,
      password_hash         TEXT    NOT NULL,
      email                 TEXT,
      role                  TEXT    NOT NULL DEFAULT 'user',
      force_password_change INTEGER NOT NULL DEFAULT 0,
      two_fa_enabled        INTEGER NOT NULL DEFAULT 0,
      enabled               INTEGER NOT NULL DEFAULT 1,
      created_at            INTEGER NOT NULL,
      last_seen             INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otp_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT    NOT NULL,
      purpose    TEXT    NOT NULL,
      expires_at INTEGER NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT    PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      text         TEXT,
      image_path   TEXT,
      view_once    INTEGER NOT NULL DEFAULT 0,
      is_blurred   INTEGER NOT NULL DEFAULT 0,
      reply_to_id  TEXT,
      reply_user   TEXT,
      reply_text   TEXT,
      created_at   INTEGER NOT NULL,
      submitted_at INTEGER,
      deleted_at   INTEGER,
      deleted_by   INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS message_views (
      message_id TEXT    NOT NULL REFERENCES messages(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      viewed_at  INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id   TEXT    NOT NULL REFERENCES messages(id),
      reported_by  INTEGER NOT NULL REFERENCES users(id),
      reported_at  INTEGER NOT NULL,
      reviewed     INTEGER NOT NULL DEFAULT 0,
      reviewed_by  INTEGER REFERENCES users(id),
      reviewed_at  INTEGER,
      action_taken TEXT
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      colour_scheme  TEXT,
      enter_to_send  INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      emoji      TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT    NOT NULL,
      p256dh     TEXT    NOT NULL,
      auth       TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, endpoint)
    );

    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_user    ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_exp     ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_otp_user         ON otp_tokens(user_id);
  `);

  // ── Column migrations (ALTER TABLE is idempotent via try/catch) ───────────
  for (const sql of [
    `ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN locked_until          INTEGER`,
    `ALTER TABLE users ADD COLUMN login_locked          INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE user_preferences ADD COLUMN font_size  INTEGER`,
  ]) {
    try { db.exec(sql); } catch { /* column already exists – safe to ignore */ }
  }

  // Migrate message_reactions to composite PK (message_id, user_id, emoji) if needed.
  // The original deployment used (message_id, user_id) which prevented multiple reactions
  // per user. Drop and recreate the table if the old schema is detected.
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(message_reactions)`).all() as Array<{ name: string }>;
    if (tableInfo.length > 0) {
      const pkCols = (db.prepare(
        `SELECT name FROM pragma_table_info('message_reactions') WHERE pk > 0 ORDER BY pk`,
      ).all() as Array<{ name: string }>).map(r => r.name);
      if (!pkCols.includes('emoji')) {
        // Old table with 2-column PK – recreate with correct 3-column PK
        db.exec(`
          DROP TABLE message_reactions;
          CREATE TABLE message_reactions (
            message_id TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
            emoji      TEXT    NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (message_id, user_id, emoji)
          );
        `);
      }
    }
  } catch { /* safe to ignore – table may not exist yet, handled by CREATE TABLE IF NOT EXISTS above */ }

  // ── Default settings ──────────────────────────────────────────────────────
  const defaults: Record<string, string> = {
    pwa_enabled:                '0',
    report_enabled:             '0',
    push_notifications_enabled: '0',
    site_title:             'TLS',
    main_header:            'TLS',
    enable_view_once:       '1',
    enable_blur:            '1',
    enable_emergency_exit:  '1',
    enable_delete_button:   '1',
    delete_button:          '✗',
    reply_button:           '↩',
    read_status_seen:       '✓✓',
    read_status_unread:     '✓',
  };
  const insertSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) insertSetting.run(k, v);

  // ── Seed admin from .env ──────────────────────────────────────────────────
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;
  const adminName = process.env.ADMIN_DISPLAY_NAME ?? 'Administrator';
  if (adminUser && adminPass) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUser) as { id: number } | undefined;
    if (!exists) {
      const hash = await hashPassword(adminPass);
      db.prepare(`
        INSERT INTO users (username, display_name, password_hash, role, force_password_change, enabled, created_at)
        VALUES (?, ?, ?, 'admin', 1, 1, ?)
      `).run(adminUser, adminName, hash, Date.now());
      console.log('[db] Admin user seeded (force password change on first login).');
    }
  }

  // ── Periodic cleanup of expired sessions and OTP tokens ───────────────────
  setInterval(() => {
    const now = Date.now();
    db!.prepare('DELETE FROM sessions   WHERE expires_at < ?').run(now);
    db!.prepare('DELETE FROM otp_tokens WHERE expires_at < ?').run(now);
  }, 60 * 60 * 1000);

  console.log(`[db] Database ready at ${dbPath}`);
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error('Database not initialised – call initDb() first');
  return db;
}

// ── Password hashing (Node built-in crypto.scrypt) ────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, keyHex] = (stored ?? '').split(':');
  if (!salt || !keyHex) return false;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      try {
        resolve(crypto.timingSafeEqual(Buffer.from(keyHex, 'hex'), key));
      } catch {
        resolve(false);
      }
    });
  });
}

// ── Settings helpers ──────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

export function getSettings(keys: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = getSetting(k);
  return out;
}
