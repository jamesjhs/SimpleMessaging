'use strict';

// Plain JS so this check can run before native dependencies/tsx are installed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

function checkRuntime() {
  console.log(`[platform] Detected Node ${process.versions.node} on ${process.platform}/${process.arch}`);
  console.log(`[platform] Node executable: ${process.execPath}`);
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 22 && major <= 26, 'Use Node.js 22 through 26; 32-bit Linux ARM requires Node.js 22.');
  if (process.platform === 'linux' && process.arch === 'arm') {
    assert.equal(major, 22, 'Use Node.js 22 on 32-bit ARM: Node.js 24 downgraded ARMv7 to experimental.');
    assert.ok(Number(process.config.variables.arm_version) >= 7, 'ARMv7 or newer hardware is required; original Pi/Zero ARMv6 boards are unsupported.');
    const glibc = process.report.getReport().header.glibcVersionRuntime;
    console.log(`[platform] Runtime libc: ${glibc ? `glibc ${glibc}` : 'not reported by Node (glibc could not be confirmed)'}`);
    const [glibcMajor, glibcMinor] = (glibc || '0.0').split('.').map(Number);
    assert.ok(glibcMajor > 2 || (glibcMajor === 2 && glibcMinor >= 31), `Sharp 0.34.5's prebuilt 32-bit ARM binary requires glibc >= 2.31; detected ${glibc || 'unknown libc'}. Check: getconf GNU_LIBC_VERSION and cat /etc/os-release. Use Debian / Raspberry Pi OS 11 or newer armhf (not Alpine/musl). Reinstalling Node does not upgrade the OS libc.`);
    if (process.argv.includes('--raspberry-pi')) {
      const release = fs.readFileSync('/etc/os-release', 'utf8');
      assert.match(release, /^ID=(?:"?debian"?|"?raspbian"?)$/m, 'Expected Debian or Raspberry Pi OS.');
      const releaseVersion = release.match(/^VERSION_ID="?(\d+)"?$/m);
      assert.ok(releaseVersion && Number(releaseVersion[1]) >= 11, 'Expected Debian / Raspberry Pi OS 11 or newer.');
    }
    console.log(`[platform] linux/arm, ARMv${process.config.variables.arm_version}, glibc ${glibc}, Node ${process.versions.node}`);
  } else {
    assert.ok(!process.argv.includes('--raspberry-pi'), '--raspberry-pi must run on the actual 32-bit Linux ARM host.');
    console.log(`[platform] ${process.platform}/${process.arch}, Node ${process.versions.node}`);
  }
}

async function checkDependencies() {
  for (const name of ['dotenv', 'express', 'multer', 'nodemailer', 'web-push']) require(name);
  const crypto = require('node:crypto');
  const webPush = require('web-push');
  const vapid = webPush.generateVAPIDKeys();
  const subscriber = crypto.createECDH('prime256v1');
  subscriber.generateKeys();
  const pushRequest = webPush.generateRequestDetails({
    endpoint: 'https://example.invalid/push-test',
    keys: { p256dh: subscriber.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  }, 'dependency compatibility check', {
    vapidDetails: { subject: 'mailto:compatibility@example.invalid', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  });
  assert.ok(pushRequest.body.length > 0);
  const mail = await require('nodemailer').createTransport({ jsonTransport: true }).sendMail({
    from: 'compatibility@example.invalid', to: 'recipient@example.invalid', subject: 'Compatibility check', text: 'No network is used.',
  });
  assert.ok(mail.message);
  console.log('[platform] Web push encryption/VAPID and email composition passed (no network)');
  // Exercise disk-backed encryption and WAL; never open the application's DB.
  const Database = require('../lib/sqlite-driver.cjs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-platform-'));
  const file = path.join(temp, 'probe.db');
  const key = 'ab'.repeat(32); // disposable test key, unrelated to .env
  let db;
  const open = () => {
    const connection = new Database(file);
    connection.pragma("cipher='sqlcipher'");
    connection.pragma(`key="x'${key}'"`);
    return connection;
  };
  try {
    db = open();
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES (\'ok\')');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    db = open();
    assert.deepEqual(db.prepare('SELECT value FROM probe').get(), { value: 'ok' });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.notEqual(fs.readFileSync(file).subarray(0, 15).toString(), 'SQLite format 3');
  } finally {
    if (db?.open) db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('[platform] Encrypted SQLite disk/WAL round trip passed');

  const sharp = require('sharp');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  const png = await sharp(svg).resize(4, 4).png().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  assert.equal((await sharp(webp).metadata()).width, 4);
  assert.equal((await sharp(jpeg).metadata()).format, 'jpeg');
  console.log(`[platform] Sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}: SVG/PNG/WebP/JPEG passed`);

  // These tools also ship architecture-specific executables. Resolve and run
  // their actual binaries rather than trusting only package metadata.
  const tsPackage = require.resolve('typescript/package.json');
  const compiler = path.join(path.dirname(tsPackage), 'bin', 'tsc');
  const version = spawnSync(process.execPath, [compiler, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr || version.error?.message || 'TypeScript native binary could not run');
  const runner = spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('esbuild').transformSync('const value: number = 1', { loader: 'ts' })"], { encoding: 'utf8' });
  assert.equal(runner.status, 0, runner.stderr || runner.error?.message || 'tsx/esbuild could not run');
  console.log(`[platform] ${version.stdout.trim()}, tsx/esbuild passed`);
}

async function main() {
  checkRuntime();
  if (!process.argv.includes('--runtime-only')) await checkDependencies();
}
main().catch(error => {
  console.error(`[platform] FAILED: ${error.message}`);
  if (process.platform === 'linux' && Number(process.versions.node.split('.')[0]) < 22) {
    console.error('[platform] If Node 22 is installed as documented, select it first: export PATH="/opt/tls-node22/bin:$PATH"');
    console.error('[platform] If using nvm: nvm install 22 && nvm use 22');
  }
  console.error('[platform] Resolve the requirement reported above, then run npm ci --include=dev --include=optional on the target machine and npm run check:platform. Do not copy node_modules from another OS/CPU.');
  process.exitCode = 1;
});
