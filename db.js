'use strict';

const Database = require('better-sqlite3-multiple-ciphers');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let db = null;

/**
 * Derives a 32-byte key from an arbitrary passphrase string using SHA-256.
 * This ensures the PRAGMA key is always exactly 64 hex characters (256-bit AES).
 * @param {string} passphrase
 * @returns {string} 64-character hex string
 */
function deriveDbKey(passphrase) {
  return crypto.createHash('sha256').update(passphrase).digest('hex');
}

/**
 * Opens (or creates) the encrypted SQLite database, runs schema migrations,
 * and seeds the initial admin user from environment variables.
 */
async function initDb() {
  const dbPath = path.resolve(process.env.DB_PATH || './data/tls.db');
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const passphrase = process.env.DB_ENCRYPTION_KEY;
  if (!passphrase) throw new Error('DB_ENCRYPTION_KEY is required in .env');

  db = new Database(dbPath);

  // Apply SQLCipher encryption – must be done before any other operation
  const hexKey = deriveDbKey(passphrase);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${hexKey}'"`);

  // Performance & integrity pragmas
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
      id          TEXT    PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      text        TEXT,
      image_path  TEXT,
      view_once   INTEGER NOT NULL DEFAULT 0,
      is_blurred  INTEGER NOT NULL DEFAULT 0,
      reply_to_id TEXT,
      reply_user  TEXT,
      reply_text  TEXT,
      created_at  INTEGER NOT NULL,
      submitted_at INTEGER,
      deleted_at  INTEGER,
      deleted_by  INTEGER REFERENCES users(id)
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

    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_user   ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_exp    ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_otp_user        ON otp_tokens(user_id);
  `);

  // ── Default settings (INSERT OR IGNORE so existing values are preserved) ──
  const defaults = {
    pwa_enabled:            '0',
    report_enabled:         '0',
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
  const adminName = process.env.ADMIN_DISPLAY_NAME || 'Administrator';
  if (adminUser && adminPass) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUser);
    if (!exists) {
      const hash = await hashPassword(adminPass);
      db.prepare(`
        INSERT INTO users (username, display_name, password_hash, role, force_password_change, enabled, created_at)
        VALUES (?, ?, ?, 'admin', 1, 1, ?)
      `).run(adminUser, adminName, hash, Date.now());
      console.log(`[db] Admin user '${adminUser}' seeded (force password change on first login).`);
    }
  }

  // ── Periodic cleanup ───────────────────────────────────────────────────────
  setInterval(() => {
    const now = Date.now();
    db.prepare('DELETE FROM sessions   WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM otp_tokens WHERE expires_at < ?').run(now);
  }, 60 * 60 * 1000);

  console.log(`[db] Database ready at ${dbPath}`);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialised – call initDb() first');
  return db;
}

// ── Password hashing (Node built-in crypto.scrypt) ────────────────────────────

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

async function verifyPassword(password, stored) {
  const [salt, keyHex] = (stored || '').split(':');
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

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getSettings(keys) {
  const out = {};
  for (const k of keys) out[k] = getSetting(k);
  return out;
}

module.exports = { initDb, getDb, hashPassword, verifyPassword, getSetting, setSetting, getSettings };
