import Database from './sqlite-driver.cjs';
import type { Database as DB } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { deriveDbKey } from '../db';

export const databasePath = () => path.resolve(process.env.DB_PATH ?? './data/tls.db');
export const pendingPath = () => `${databasePath()}.restore-pending`;

export function openEncrypted(file: string, readonly = true): DB {
  if (!fs.existsSync(file)) throw new Error('Database file does not exist');
  const passphrase = process.env.DB_ENCRYPTION_KEY;
  if (!passphrase) throw new Error('DB_ENCRYPTION_KEY is required');
  const db = new Database(file, { readonly, fileMustExist: true });
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma(`key="x'${deriveDbKey(passphrase)}'"`);
    db.pragma('trusted_schema = OFF');
    return db;
  } catch (err) { db.close(); throw err; }
}

export function validateDatabase(file: string) {
  const db = openEncrypted(file);
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Integrity check failed');
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Foreign key check failed');
    // Require this release's schema, including columns used by authentication.
    const required: Record<string, string[]> = {
      users: ['id', 'username', 'display_name', 'password_hash', 'email', 'role', 'enabled', 'force_password_change', 'two_fa_enabled', 'created_at', 'last_seen', 'failed_login_attempts', 'locked_until', 'login_locked'],
      sessions: ['token', 'user_id', 'csrf_token', 'created_at', 'expires_at'],
      otp_tokens: ['id', 'user_id', 'token', 'purpose', 'expires_at', 'used', 'created_at'],
      messages: ['id', 'user_id', 'text', 'image_path', 'blur_preview_path', 'view_once', 'is_blurred', 'reply_to_id', 'reply_user', 'reply_text', 'created_at', 'submitted_at', 'deleted_at', 'deleted_by'],
      message_views: ['message_id', 'user_id', 'viewed_at'],
      reports: ['id', 'message_id', 'reported_by', 'reported_at', 'reason', 'reviewed', 'reviewed_by', 'reviewed_at', 'action_taken', 'outcome_message'],
      user_preferences: ['user_id', 'colour_scheme', 'enter_to_send', 'push_enabled', 'updated_at', 'font_size', 'font_family'],
      app_settings: ['key', 'value'], message_reactions: ['message_id', 'user_id', 'emoji', 'created_at'],
      push_subscriptions: ['id', 'user_id', 'endpoint', 'p256dh', 'auth', 'created_at'],
    };
    for (const [table, columns] of Object.entries(required)) {
      const type = db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(table) as { type: string } | undefined;
      const actual = (db.pragma(`table_info(${table})`) as { name: string }[]).map(c => c.name);
      if (type?.type !== 'table' || columns.some(c => !actual.includes(c))) throw new Error(`Incompatible schema: ${table}`);
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view')").get()) throw new Error('Unexpected triggers or views');
    const admins = (db.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin' AND enabled = 1").get() as { count: number }).count;
    if (!admins) throw new Error('Backup has no enabled administrator');
    return { valid: true, admins, users: (db.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count };
  } finally { db.close(); }
}

/** Checkpoint, then lock out writers while copying the encrypted main file. */
export function exportDatabase(db: DB, destination: string): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const wal = `${databasePath()}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) throw new Error('Database busy; retry export');
    fs.copyFileSync(databasePath(), destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
  } finally { db.exec('ROLLBACK'); }
}

/** Called before initDb/listen; never replaces an open application database. */
export function applyPendingRestore(): void {
  if (!fs.existsSync(pendingPath())) return;
  validateDatabase(pendingPath());
  const target = databasePath();
  const recovery = `${target}.before-restore-${Date.now()}-${crypto.randomUUID()}`;
  if (fs.existsSync(target)) {
    const live = openEncrypted(target, false);
    try { exportDatabase(live, recovery); } finally { live.close(); }
  }
  // Prepare a standalone restored copy and revoke all restored login/OTP tokens.
  const candidate = `${target}.restore-working`;
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(candidate + suffix, { force: true });
  fs.copyFileSync(pendingPath(), candidate);
  fs.chmodSync(candidate, 0o600);
  const restored = openEncrypted(candidate, false);
  try {
    restored.pragma('journal_mode = DELETE');
    restored.transaction(() => {
      restored.exec('DELETE FROM sessions; DELETE FROM otp_tokens; DELETE FROM push_subscriptions;');
    })();
  } finally { restored.close(); }
  validateDatabase(candidate);
  // No other application process may have this DB open during startup restore.
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
  fs.renameSync(candidate, target);
  fs.rmSync(pendingPath());
  console.log(`[db] Restore applied; previous database retained at ${recovery}`);
}
