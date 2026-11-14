import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getDb, verifyPassword } from '../db';
import { databasePath, pendingPath, exportDatabase, validateDatabase } from '../lib/databaseMaintenance';
import { rateLimiter } from '../lib/rateLimiter';

// Mounted ONLY beneath adminRouter's requireAdmin and CSRF middleware.
const router = Router();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-database-'));
fs.chmodSync(tempDir, 0o700);
const upload = multer({ dest: tempDir, limits: { fileSize: 256 * 1024 * 1024, files: 1, fields: 0 } });
const previews = new Map<string, { file: string; session: string; expires: number }>();
function clean(file: string) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true });
}
setInterval(() => {
  for (const [token, preview] of previews) {
    if (preview.expires < Date.now()) { clean(preview.file); previews.delete(token); }
  }
}, 60_000).unref();
process.once('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.user?.force_password_change) { res.status(403).json({ error: 'Change your password before database maintenance.' }); return; }
  next();
});

router.get('/status', (_req, res) => {
  res.json({ pendingRestore: fs.existsSync(pendingPath()), restartEnabled: process.env.ADMIN_RESTART_ENABLED === 'true', maxUploadBytes: 256 * 1024 * 1024 });
});

router.get('/export', (_req, res, next) => {
  const file = path.join(tempDir, `${crypto.randomUUID()}.db`);
  try {
    exportDatabase(getDb(), file);
    validateDatabase(file);
    res.download(file, `tls-database-${new Date().toISOString().replace(/[:.]/g, '-')}.db`, err => {
      clean(file);
      if (err && !res.headersSent) next(err);
    });
  } catch (err) { clean(file); next(err); }
});

router.post('/validate', (req, res, next) => {
  upload.single('database')(req, res, err => {
    if (err) { res.status(400).json({ error: 'Upload one database file, maximum 256 MiB.' }); return; }
    if (!req.file) { res.status(400).json({ error: 'Database file required' }); return; }
    const file = req.file.path;
    try {
      fs.chmodSync(file, 0o600);
      const result = validateDatabase(file);
      // One validation per session keeps disk use bounded for repeated uploads.
      for (const [token, preview] of previews) {
        if (preview.session === req.sessionToken) { clean(preview.file); previews.delete(token); }
      }
      const token = crypto.randomUUID();
      previews.set(token, { file, session: req.sessionToken!, expires: Date.now() + 15 * 60_000 });
      res.json({ ...result, validationToken: token, expiresInSeconds: 900, message: 'Database only: media and server configuration must be restored separately.' });
    } catch {
      clean(file);
      res.status(400).json({ error: 'Validation failed: wrong encryption key, damaged database, incompatible schema, or no enabled admin. Use a backup from this release and its original DB_ENCRYPTION_KEY.' });
    }
  });
});

// Re-check current credentials for destructive operations; never accept a password from the backup.
router.use(rateLimiter({ windowMs: 60_000, max: 5 }), async (req, res, next) => {
  const password = req.body?.password;
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
  if (typeof password !== 'string' || password.length > 1024 || !await verifyPassword(password, row.password_hash)) {
    res.status(403).json({ error: 'Current admin password required' }); return;
  }
  next();
});

router.post('/restore', (req, res) => {
  if (req.body?.confirm !== 'RESTORE') { res.status(400).json({ error: 'confirm must be RESTORE' }); return; }
  const preview = previews.get(req.body?.validationToken);
  if (!preview || preview.session !== req.sessionToken || preview.expires < Date.now()) {
    res.status(400).json({ error: 'Validate the file again; validation expired or belongs to another session.' }); return;
  }
  if (fs.existsSync(pendingPath())) { res.status(409).json({ error: 'A restore is already pending. Cancel it first.' }); return; }
  validateDatabase(preview.file);
  const staging = `${databasePath()}.restore-${crypto.randomUUID()}`;
  try {
    fs.copyFileSync(preview.file, staging, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(staging, 0o600);
    fs.renameSync(staging, pendingPath());
  } finally { fs.rmSync(staging, { force: true }); }
  clean(preview.file);
  previews.delete(req.body.validationToken);
  res.json({ pendingRestore: true, message: 'Restore staged. Restart to apply. Changes made after the backup will be replaced. All users must sign in again with backup credentials.' });
});

router.delete('/restore', (_req, res) => {
  fs.rmSync(pendingPath(), { force: true });
  res.json({ pendingRestore: false });
});

router.post('/restart', (req, res) => {
  if (req.body?.confirm !== 'RESTART') { res.status(400).json({ error: 'confirm must be RESTART' }); return; }
  if (process.env.ADMIN_RESTART_ENABLED !== 'true' || typeof req.app.locals.restart !== 'function') {
    res.status(409).json({ error: 'Restart unavailable. Configure a process supervisor and ADMIN_RESTART_ENABLED=true, or restart the service on the server.' }); return;
  }
  res.once('finish', () => req.app.locals.restart());
  res.status(202).json({ message: 'Restart requested. Wait for service recovery, then sign in again.' });
});

export default router;
