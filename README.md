# TLS – Secure Messaging

Version 1.2.4

A self-hosted, end-to-end encrypted two-person chat application built with **Node.js**, **TypeScript**, **Express 5**, and **SQLCipher** (via `better-sqlite3-multiple-ciphers`).

---

## Features

- **SQLCipher-encrypted SQLite** database (`DB_ENCRYPTION_KEY` in `.env`)
- **Session-cookie authentication** (7-day TTL, HttpOnly, SameSite=Strict)
- **Cloudflare Turnstile** captcha on login (optional; disabled if `TURNSTILE_SITE_KEY` is unset)
- **2FA via OTP email** (opt-in per user)
- **Forced password change** on first login
- **Report function** – flag messages to admin with `!` button (admin-configurable)
- **Read receipts** – ✓ server received, ✓✓ read by other user
- **Soft-delete** – deleted message content is retained for audit, access is removed
- **View-once** images and videos
- **Image blur** toggle (NSFW/sensitive media)
- **In-app video recorder** with optional FFmpeg WASM compression
- **Swipe-to-reply** and reply threading
- **Typing indicator**
- **Emergency exit** (configurable)
- **Admin-controlled colour schemes** – 10 built-in palettes, with admin-selected availability for users
- **Font preferences** – users can choose Default Sans, Serif, or Friendly; admins set the default font
- **Configurable app name** – admin-set app name is used throughout the UI, PWA metadata, notifications, and emails; default is `Messaging`
- **Admin panel** – user management, report review, settings, icon upload, `posts.json` import
- **PWA support** – installable app metadata, service worker, push notifications, and generated compliant PNG/maskable icons

---

## Quick Start

### 1. Prerequisites

- **Node.js 20+** (production target: Node.js 24)
- A working **SMTP** server for OTP and invite emails

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your settings
```

Key variables:

| Variable | Required | Description |
|---|---|---|
| `DB_ENCRYPTION_KEY` | ✅ | Database encryption passphrase (any string; keep secret) |
| `ADMIN_USERNAME` | ✅ | Initial admin username |
| `ADMIN_PASSWORD` | ✅ | Initial admin password (force-change on first login) |
| `SMTP_HOST` | For email | SMTP server hostname |
| `SMTP_PORT` | For email | SMTP port (default: 587) |
| `SMTP_USER` / `SMTP_PASSWORD` | For email | SMTP credentials |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Optional | Cloudflare Turnstile (skip for dev) |
| `APP_URL` | For email | Full public URL (e.g. `https://chat.example.com`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | For web push | Required before the admin can enable push notifications |
| `TRUST_PROXY` | Optional | Trusted proxy hop count / Express trust-proxy value (set to `1` behind one reverse proxy) |
| `PORT` | Optional | HTTP port (default: 3333) |

### 4. Run

```bash
# Development (watch mode):
npm run dev

# Production:
npm start

# Type-check only:
npm run typecheck

# Compile to dist/:
npm run build
```

The app listens on `http://localhost:3333` by default.

Push notifications remain off by default. To use them, the administrator must enable both PWA support and push notifications in the admin panel after configuring VAPID keys, and each user must install the PWA on their device before opting in from the in-app settings panel.

---

## Architecture

```
server.ts            Express entry point
db.ts                SQLCipher DB init, schema, password hashing, settings
lib/auth.ts          Sessions, cookies, OTP, Turnstile, SMTP
lib/appName.ts       Configured app-name fallback handling
lib/colourSchemes.ts Colour palette registry and validation
lib/fontOptions.ts   Font registry and validation
routes/
  auth.ts            Login, OTP verification, logout, change-password
  messages.ts        Chat messages, typing, view-once, reports, preferences
  admin.ts           User management, reports, settings, import
types.ts             Shared TypeScript interfaces
typings/             Ambient declaration for better-sqlite3-multiple-ciphers
public/
  index.html / style.css / script.js    Chat UI (browser JS)
  admin.html / admin.css / admin.js     Admin panel
  manifest.json / sw.js                 PWA (disabled by default)
  pwa-icon-*.png / favicon-32.png       Generated PWA and browser icons
```

---

## Importing Historical Messages

1. Go to **Admin → Import**
2. Upload a `posts.json` file (array of message objects from the previous version)
3. Messages are matched to existing users by `display_name`
4. Unmatched display names get stub accounts created with temporary passwords

---

## Security Notes

- The database file at `data/tls.db` is AES-256 encrypted (SQLCipher)
- Session tokens are 32-byte cryptographically random values stored in the DB
- Passwords are hashed with `crypto.scrypt` (N=16384, 64-byte output)
- Session cookies are `Secure` whenever the request is HTTPS (including TLS terminated at a trusted reverse proxy)
- Deleted messages retain their content in the DB for admin audit; only access is revoked
- The `/uploads/` route requires a valid session cookie
- COOP + COEP headers are set to enable SharedArrayBuffer for FFmpeg WASM

---

## Licence

Private / proprietary – all rights reserved.

## Password reset

# Powershell

@'
require("dotenv").config();
const Database = require("better-sqlite3-multiple-ciphers");
const crypto = require("crypto");
const path = require("path");

function deriveDbKey(passphrase) {
  return crypto.pbkdf2Sync(
    passphrase,
    Buffer.from("tls-db-key-v1", "utf8"),
    100000,
    32,
    "sha256"
  ).toString("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`${salt}:${key.toString("hex")}`);
    });
  });
}

(async () => {
  const passphrase = process.env.DB_ENCRYPTION_KEY;
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!passphrase) throw new Error("DB_ENCRYPTION_KEY is missing");
  if (!username) throw new Error("ADMIN_USERNAME is missing");
  if (!password) throw new Error("ADMIN_PASSWORD is missing");

  const dbPath = path.resolve(process.env.DB_PATH || "./data/tls.db");
  const db = new Database(dbPath);

  db.pragma("cipher='sqlcipher'");
  db.pragma(`key="x'${deriveDbKey(passphrase)}'"`);

  const hash = await hashPassword(password);

  const result = db.prepare(`
    UPDATE users
    SET password_hash = ?,
        force_password_change = 1,
        failed_login_attempts = 0,
        locked_until = NULL,
        login_locked = 0
    WHERE username = ? AND role = 'admin'
  `).run(hash, username);

  console.log(`Reset password for ${result.changes} admin account(s): ${username}`);
  db.close();
})();
'@ | node

# Bash

node <<'NODE'
require("dotenv").config();
const Database = require("better-sqlite3-multiple-ciphers");
const crypto = require("crypto");
const path = require("path");

function deriveDbKey(passphrase) {
  return crypto.pbkdf2Sync(
    passphrase,
    Buffer.from("tls-db-key-v1", "utf8"),
    100000,
    32,
    "sha256"
  ).toString("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`${salt}:${key.toString("hex")}`);
    });
  });
}

(async () => {
  const passphrase = process.env.DB_ENCRYPTION_KEY;
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!passphrase) throw new Error("DB_ENCRYPTION_KEY is missing");
  if (!username) throw new Error("ADMIN_USERNAME is missing");
  if (!password) throw new Error("ADMIN_PASSWORD is missing");

  const dbPath = path.resolve(process.env.DB_PATH || "./data/tls.db");
  const db = new Database(dbPath);

  db.pragma("cipher='sqlcipher'");
  db.pragma(`key="x'${deriveDbKey(passphrase)}'"`);

  const hash = await hashPassword(password);

  const result = db.prepare(`
    UPDATE users
    SET password_hash = ?,
        force_password_change = 1,
        failed_login_attempts = 0,
        locked_until = NULL,
        login_locked = 0
    WHERE username = ? AND role = 'admin'
  `).run(hash, username);

  console.log(`Reset password for ${result.changes} admin account(s): ${username}`);
  db.close();
})();
NODE

## Account reset 

# Powershell 

@'
require("dotenv").config();
const Database = require("better-sqlite3-multiple-ciphers");
const crypto = require("crypto");
const path = require("path");

const passphrase = process.env.DB_ENCRYPTION_KEY;
const username = process.env.ADMIN_USERNAME;
if (!passphrase) throw new Error("DB_ENCRYPTION_KEY is missing");
if (!username) throw new Error("ADMIN_USERNAME is missing");

const dbPath = path.resolve(process.env.DB_PATH || "./data/tls.db");
const key = crypto.pbkdf2Sync(passphrase, Buffer.from("tls-db-key-v1", "utf8"), 100000, 32, "sha256").toString("hex");

const db = new Database(dbPath);
db.pragma("cipher='sqlcipher'");
db.pragma(`key="x'${key}'"`);

const result = db.prepare(`
  UPDATE users
  SET failed_login_attempts = 0,
      locked_until = NULL,
      login_locked = 0
  WHERE username = ? AND role = 'admin'
`).run(username);

console.log(`Unlocked ${result.changes} admin account(s): ${username}`);
db.close();
'@ | node

# Bash

node <<'NODE'
require("dotenv").config();
const Database = require("better-sqlite3-multiple-ciphers");
const crypto = require("crypto");
const path = require("path");

const passphrase = process.env.DB_ENCRYPTION_KEY;
const username = process.env.ADMIN_USERNAME;
if (!passphrase) throw new Error("DB_ENCRYPTION_KEY is missing");
if (!username) throw new Error("ADMIN_USERNAME is missing");

const dbPath = path.resolve(process.env.DB_PATH || "./data/tls.db");
const key = crypto.pbkdf2Sync(passphrase, Buffer.from("tls-db-key-v1", "utf8"), 100000, 32, "sha256").toString("hex");

const db = new Database(dbPath);
db.pragma("cipher='sqlcipher'");
db.pragma(`key="x'${key}'"`);

const result = db.prepare(`
  UPDATE users
  SET failed_login_attempts = 0,
      locked_until = NULL,
      login_locked = 0
  WHERE username = ? AND role = 'admin'
`).run(username);

console.log(`Unlocked ${result.changes} admin account(s): ${username}`);
db.close();
NODE
