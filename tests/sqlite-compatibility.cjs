'use strict';

// Run under Node 22 with TLS_LEGACY_DRIVER pointing to an isolated v12.9.0
// installation. Confirms encrypted files can move both ways between Pi/modern.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
assert.equal(Number(process.versions.node.split('.')[0]), 22);
assert.ok(process.env.TLS_LEGACY_DRIVER, 'Set TLS_LEGACY_DRIVER to the legacy driver package directory');
const Legacy = require(process.env.TLS_LEGACY_DRIVER);
const Modern = require('../node_modules/better-sqlite3-multiple-ciphers');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-driver-compat-'));
let db;
function open(Driver, file) {
  const connection = new Driver(file);
  connection.pragma("cipher='sqlcipher'");
  connection.pragma(`key="x'${'cd'.repeat(32)}'"`);
  return connection;
}
try {
  for (const [name, Writer, Reader] of [['legacy-to-modern', Legacy, Modern], ['modern-to-legacy', Modern, Legacy]]) {
    const file = path.join(dir, `${name}.db`);
    db = open(Writer, file);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE compatibility (value TEXT); INSERT INTO compatibility VALUES (\'original\')');
    db.close();
    db = open(Reader, file);
    assert.deepEqual(db.prepare('SELECT value FROM compatibility').get(), { value: 'original' });
    db.prepare('UPDATE compatibility SET value = ?').run('updated');
    db.close();
    db = open(Writer, file);
    assert.deepEqual(db.prepare('SELECT value FROM compatibility').get(), { value: 'updated' });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
    console.log(`[compatibility] ${name}: encrypted read/write round trip passed`);
  }
} finally {
  if (db?.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
