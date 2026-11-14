import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('server starts and supports login, password change and admin database export', { timeout: 30_000 }, async () => {
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-startup-test-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'test.db'),
      DB_ENCRYPTION_KEY: 'startup-test-key-only', ADMIN_USERNAME: 'startup-admin',
      ADMIN_PASSWORD: 'StartupPassword123!', TURNSTILE_SECRET_KEY: '',
      ADMIN_RESTART_ENABLED: 'false', APP_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let exited = false;
  const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (exited) assert.fail(`Server exited before ready: ${output}`);
      try { ready = (await fetch(`${base}/readyz`)).ok; } catch { /* still starting */ }
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, output);
    assert.equal((await fetch(`${base}/api/admin/database/export`)).status, 401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'startup-admin', password: 'StartupPassword123!' }),
    });
    assert.equal(login.status, 200, output);
    const auth = await login.json() as { csrfToken: string; status: string };
    assert.equal(auth.status, 'change_password');
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const changed = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': auth.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'StartupPassword123!', newPassword: 'ChangedPassword456!' }),
    });
    assert.ok(changed.ok, await changed.text());
    const admin = await fetch(`${base}/admin`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /database-validate/);
    const exported = await fetch(`${base}/api/admin/database/export`, { headers: { Cookie: cookie } });
    assert.equal(exported.status, 200);
    assert.ok((await exported.arrayBuffer()).byteLength > 0);
  } finally {
    if (!exited) child.kill();
    await exit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
