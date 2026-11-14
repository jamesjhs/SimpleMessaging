import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { hashPassword } from '../db';
import { getPasswordPolicyError } from '../lib/passwordPolicy';
import { databasePath, pendingPath, openEncrypted, validateDatabase, exportDatabase, applyPendingRestore } from '../lib/databaseMaintenance';

async function main() {
  const [command, argument, confirm] = process.argv.slice(2);
  if (command === 'validate' && argument) {
    console.log(validateDatabase(path.resolve(argument)));
  } else if (command === 'export' && argument) {
    const db = openEncrypted(databasePath(), false);
    try { exportDatabase(db, path.resolve(argument)); } finally { db.close(); }
    console.log(validateDatabase(path.resolve(argument)));
  } else if (command === 'restore' && argument && confirm === '--server-stopped') {
    if (fs.existsSync(pendingPath())) throw new Error('A restore is already pending; inspect it before proceeding.');
    validateDatabase(path.resolve(argument));
    fs.copyFileSync(path.resolve(argument), pendingPath(), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(pendingPath(), 0o600);
    applyPendingRestore();
  } else if (command === 'reset-admin' && argument && confirm === '--server-stopped') {
    const password = process.env.RESET_ADMIN_PASSWORD;
    if (!password) throw new Error('Set RESET_ADMIN_PASSWORD in this shell only.');
    const error = getPasswordPolicyError(password);
    if (error) throw new Error(error);
    const hash = await hashPassword(password);
    const db = openEncrypted(databasePath(), false);
    try {
      db.transaction(() => {
        const user = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'admin'").get(argument) as { id: number } | undefined;
        if (!user) throw new Error('Existing administrator not found; no account changed.');
        db.prepare(`UPDATE users SET password_hash = ?, enabled = 1, force_password_change = 1,
          two_fa_enabled = 0, failed_login_attempts = 0, locked_until = NULL, login_locked = 0 WHERE id = ?`).run(hash, user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM otp_tokens WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(user.id);
      })();
    } finally { db.close(); }
    console.log('Admin reset. Change the temporary password at next login and re-enable 2FA.');
  } else {
    throw new Error('Usage: npm run database -- validate FILE | export FILE | restore FILE --server-stopped | reset-admin USERNAME --server-stopped');
  }
}
main().catch(err => { console.error('[database]', err.message); process.exitCode = 1; });
