import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import express from 'express';
import Database from '../lib/sqlite-driver.cjs';
import { initDb, verifyPassword } from '../db';
import adminRouter from '../routes/admin';
import { databasePath, pendingPath, openEncrypted, validateDatabase, exportDatabase, applyPendingRestore } from '../lib/databaseMaintenance';

test('encrypted export, admin API authorization, restore and offline admin recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-maintenance-test-'));
  process.env.DB_PATH = path.join(dir, 'live.db');
  process.env.DB_ENCRYPTION_KEY = 'test-only-database-key';
  process.env.ADMIN_USERNAME = 'testadmin';
  process.env.ADMIN_PASSWORD = 'TestPassword123!';
  process.env.ADMIN_RESTART_ENABLED = 'false';
  const db = await initDb();
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/admin/database`;
  let clientIp = '127.0.0.1';
  const request = (route: string, method = 'GET', body?: unknown, session = 'admin', csrf = true) => fetch(base + route, {
    method, headers: { Cookie: `session=${session}`, 'X-Forwarded-For': clientIp, ...(csrf ? { 'X-CSRF-Token': 'csrf-test' } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const adminId = (db.prepare('SELECT id FROM users WHERE username = ?').get('testadmin') as { id: number }).id;
  db.prepare('UPDATE users SET force_password_change = 0 WHERE id = ?').run(adminId);
  const addSession = (token: string, id: number) => db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(token, id, 'csrf-test', Date.now(), Date.now() + 3600000);
  addSession('admin', adminId);
  addSession('second-admin-session', adminId);
  for (const role of ['user', 'adult']) {
    const user = db.prepare('INSERT INTO users (username, display_name, password_hash, role, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(role, role, 'unused', role, Date.now());
    addSession(role, Number(user.lastInsertRowid));
  }
  const backup = path.join(dir, 'backup.db');
  try {
    for (const session of ['missing', 'user', 'adult']) {
      for (const [route, method] of [['/export', 'GET'], ['/validate', 'POST'], ['/restore', 'POST'], ['/restore', 'DELETE'], ['/restart', 'POST']]) {
        assert.equal((await request(route, method, undefined, session)).status, session === 'missing' ? 401 : 403);
      }
    }
    assert.equal((await request('/validate', 'POST', {}, 'admin', false)).status, 403);
    db.prepare('UPDATE users SET force_password_change = 1 WHERE id = ?').run(adminId);
    assert.equal((await request('/export')).status, 403);
    db.prepare('UPDATE users SET force_password_change = 0 WHERE id = ?').run(adminId);
    db.prepare("INSERT INTO app_settings VALUES ('backup_marker', 'in-wal')").run();
    const download = await request('/export');
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    fs.writeFileSync(backup, Buffer.from(await download.arrayBuffer()));
    assert.notEqual(fs.readFileSync(backup).subarray(0, 15).toString(), 'SQLite format 3');
    const plain = new Database(backup, { readonly: true });
    assert.throws(() => plain.prepare('SELECT * FROM users').all());
    plain.close();
    assert.equal(validateDatabase(backup).users, 3);
    const snapshot = openEncrypted(backup);
    assert.deepEqual(snapshot.prepare("SELECT value FROM app_settings WHERE key = 'backup_marker'").get(), { value: 'in-wal' });
    snapshot.close();
    assert.throws(() => exportDatabase(db, backup));
    process.env.DB_ENCRYPTION_KEY = 'wrong-key';
    assert.throws(() => validateDatabase(backup));
    process.env.DB_ENCRYPTION_KEY = 'test-only-database-key';
    const invalid = path.join(dir, 'invalid.db');
    fs.writeFileSync(invalid, 'corrupt');
    assert.throws(() => validateDatabase(invalid));
    const noAdmin = path.join(dir, 'no-admin.db');
    fs.copyFileSync(backup, noAdmin);
    const bad = openEncrypted(noAdmin, false);
    bad.exec("UPDATE users SET enabled = 0 WHERE role = 'admin'");
    bad.close();
    assert.throws(() => validateDatabase(noAdmin), /no enabled administrator/);
    const upload = async (file: string) => {
      const form = new FormData();
      form.append('database', new Blob([fs.readFileSync(file)]), 'backup.db');
      return request('/validate', 'POST', form);
    };
    assert.equal((await upload(invalid)).status, 400);
    const validation = await upload(backup);
    assert.equal(validation.status, 200);
    const { validationToken } = await validation.json() as { validationToken: string };
    const restoreBody = { password: process.env.ADMIN_PASSWORD, confirm: 'RESTORE', validationToken };
    assert.equal((await request('/restore', 'POST', restoreBody, 'second-admin-session')).status, 400);
    assert.equal((await request('/restore', 'POST', { ...restoreBody, password: 'wrong' })).status, 403);
    assert.equal((await request('/restart', 'POST', { password: process.env.ADMIN_PASSWORD, confirm: 'RESTART' })).status, 409);
    assert.equal((await request('/restore', 'POST', restoreBody)).status, 200);
    assert.equal(fs.existsSync(pendingPath()), true);
    assert.equal((await request('/restore', 'POST', restoreBody)).status, 400); // consumed token
    assert.equal((await request('/restore', 'DELETE', { password: process.env.ADMIN_PASSWORD })).status, 429);
    clientIp = '127.0.0.2';
    assert.equal((await request('/restore', 'DELETE', { password: process.env.ADMIN_PASSWORD })).status, 200);
    assert.equal(fs.existsSync(pendingPath()), false);
    const secondValidation = await (await upload(backup)).json() as { validationToken: string };
    assert.equal((await request('/restore', 'POST', { ...restoreBody, validationToken: secondValidation.validationToken })).status, 200);
    let restarts = 0;
    app.locals.restart = () => { restarts++; };
    process.env.ADMIN_RESTART_ENABLED = 'true';
    assert.equal((await request('/restart', 'POST', { password: process.env.ADMIN_PASSWORD, confirm: 'RESTART' })).status, 202);
    assert.equal(restarts, 1);
    const status = await (await request('/status')).json() as { pendingRestore: boolean };
    assert.equal(status.pendingRestore, true);
    db.prepare("UPDATE app_settings SET value = 'after-backup' WHERE key = 'backup_marker'").run();
    db.close();
    applyPendingRestore();
    assert.equal(fs.existsSync(pendingPath()), false);
    const restored = openEncrypted(databasePath());
    assert.deepEqual(restored.prepare("SELECT value FROM app_settings WHERE key = 'backup_marker'").get(), { value: 'in-wal' });
    assert.deepEqual(restored.prepare('SELECT count(*) AS count FROM sessions').get(), { count: 0 });
    restored.close();
    const recoveryFile = fs.readdirSync(dir).find(f => f.includes('.before-restore-'))!;
    const recovery = openEncrypted(path.join(dir, recoveryFile));
    assert.deepEqual(recovery.prepare("SELECT value FROM app_settings WHERE key = 'backup_marker'").get(), { value: 'after-backup' });
    recovery.close();
    const reset = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/database.ts', 'reset-admin', 'testadmin', '--server-stopped'], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, RESET_ADMIN_PASSWORD: 'NewTemporary123!' }, encoding: 'utf8',
    });
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(reset.stdout.includes('NewTemporary123!'), false);
    const resetDb = openEncrypted(databasePath());
    const account = resetDb.prepare('SELECT * FROM users WHERE id = ?').get(adminId) as { password_hash: string; force_password_change: number; two_fa_enabled: number; login_locked: number };
    assert.equal(await verifyPassword('NewTemporary123!', account.password_hash), true);
    assert.equal(account.force_password_change, 1);
    assert.equal(account.two_fa_enabled, 0);
    assert.equal(account.login_locked, 0);
    resetDb.close();
  } finally {
    if (db.open) db.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
