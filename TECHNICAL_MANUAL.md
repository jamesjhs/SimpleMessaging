# TLS — Technical Manual

**Version 1.6.1**
*TLS Secure Messaging — encrypted two-person chat*

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Architecture](#3-architecture)
4. [Environment Variables](#4-environment-variables)
5. [Database Schema](#5-database-schema)
6. [Authentication & Session Flow](#6-authentication--session-flow)
7. [API Endpoints](#7-api-endpoints)
8. [Feature Specifications](#8-feature-specifications)
9. [File Upload Handling](#9-file-upload-handling)
10. [Rate Limiting](#10-rate-limiting)
11. [Progressive Web App (PWA)](#11-progressive-web-app-pwa)
12. [Admin Panel](#12-admin-panel)
13. [Security Model](#13-security-model)
14. [Data Flows](#14-data-flows)
15. [Deployment](#15-deployment)
16. [Database Export, Restore and Admin Recovery](#16-database-export-restore-and-admin-recovery)

---

## 1. System Overview

TLS is a minimal, end-to-end encrypted, two-person secure messaging application. It is designed for private communication between two known parties (e.g. a couple, close colleagues, or a therapist and patient). Key design goals:

- **Privacy-first**: all messages, users, and settings are stored in a SQLCipher-encrypted SQLite database. No message content is ever sent to third-party services.
- **Zero telemetry**: no analytics, no tracking, no CDN dependencies in the message path.
- **Minimal attack surface**: six production dependencies, no ORM, no framework beyond Express.
- **Emergency exit**: a single click clears the browser DOM and redirects to an innocuous URL.

---

## 2. Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 for 32-bit Raspberry Pi; Node.js 22–26 on supported 64-bit hosts |
| Language | TypeScript 7 (strict mode), compiled with `tsc` or run with `tsx` |
| Web framework | Express 5 |
| Database | SQLite via `better-sqlite3-multiple-ciphers` (SQLCipher AES-256-CBC) |
| Password hashing | Node built-in `crypto.scrypt` (N=32768, r=8, p=1, keyLen=64) |
| DB key derivation | PBKDF2-SHA256 (100 000 iterations, 32-byte output) |
| Image processing | `sharp` (libvips) |
| Email | `nodemailer` (SMTP) |
| File upload | `multer` |
| CAPTCHA | Cloudflare Turnstile (optional) |
| Frontend | Vanilla JS + CSS (no framework) |
| PWA | Service Worker + Web App Manifest |

The shared `lib/sqlite-driver.cjs` loader uses `better-sqlite3-multiple-ciphers` 13.0.3 (Node-API) on supported modern hosts, allowing the same native module to run across Node 22–26 without a separate V8-ABI build for each major. Linux ARM32 automatically uses the optional `@tls/sqlite-arm32` package, whose native dependency remains pinned to 12.9.0 for its Node 22 prebuild. Version 13 has no ARMv7 prebuild. Sharp, TypeScript and tsx are also pinned, and the lockfile retains their Linux ARM optional packages. The Pi remains on Node 22; see section 15.1. Node 22 API type definitions remain the compile-time baseline so new code does not accidentally require a Node 26-only API.

---

## 3. Architecture

```
 Browser (index.html / script.js / style.css)
        │
        │  HTTP (same-origin)
        ▼
 Express server  (server.ts)
    ├─ /api/auth/*      routes/auth.ts
    ├─ /api/*           routes/messages.ts
    ├─ /api/admin/*     routes/admin.ts
    ├─ /uploads/*       protected static (session-gated)
    ├─ /readyz          health-check
    ├─ /sw.js           service worker (version-stamped at runtime)
    └─ /*               public static (index.html, style.css, script.js, icon.svg, generated PWA icons)
        │
        ▼
 SQLCipher database  (data/tls.db)
 Uploads directory   (uploads/)
 SMTP server         (optional, for 2FA / invites)
```

All server-side modules are written in TypeScript. The public directory contains only static assets: no server-side rendering. The frontend polls `/api/messages` every 2 seconds.

---

## 4. Environment Variables

Create a `.env` file in the project root (see `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_ENCRYPTION_KEY` | ✅ | Passphrase used to derive the SQLCipher AES key via PBKDF2. Must never be checked in. |
| `ADMIN_USERNAME` | ✅ (first run) | Username for the initial admin account seeded on first startup. |
| `ADMIN_PASSWORD` | ✅ (first run) | Initial admin password. Force-password-change flag is set; user must change on first login. |
| `ADMIN_DISPLAY_NAME` | Optional | Display name for the seeded admin (default: `Administrator`). |
| `PORT` | Optional | HTTP port (default: `3333`). |
| `DB_PATH` | Optional | Path to database file (default: `./data/tls.db`). |
| `APP_URL` | Optional | Public base URL, used in invite emails (default: `http://localhost:3333`). |
| `SMTP_HOST` | Optional | SMTP server hostname (required when 2FA or invites are used). |
| `SMTP_PORT` | Optional | SMTP port (default: `587`). |
| `SMTP_SECURE` | Optional | Set `true` for TLS-wrapped SMTP (port 465). |
| `SMTP_STARTTLS` | Optional | Set `true` to require STARTTLS. |
| `SMTP_USER` | Optional | SMTP authentication username. |
| `SMTP_PASSWORD` | Optional | SMTP authentication password. |
| `SMTP_FROM` | Optional | Sender address (default: configured app name with `noreply@localhost`). |
| `TURNSTILE_SECRET_KEY` | Optional | Cloudflare Turnstile secret for bot protection on the login form. |
| `TURNSTILE_SITE_KEY` | Optional | Cloudflare Turnstile site key (delivered to the browser via `/api/config`). |

---

## 5. Database Schema

The database is a single SQLite file, encrypted with SQLCipher using a key derived as follows:

```
hexKey = PBKDF2-SHA256(DB_ENCRYPTION_KEY, 'tls-db-key-v1', 100000, 32)
PRAGMA key = "x'<hexKey>'"
```

### Tables

#### `users`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `username` | TEXT UNIQUE COLLATE NOCASE | Login identifier |
| `display_name` | TEXT | Shown in chat bubbles |
| `password_hash` | TEXT | `salt:hash` format (scrypt) |
| `email` | TEXT | Optional; required for 2FA |
| `role` | TEXT | `'admin'` or `'user'` |
| `force_password_change` | INTEGER | `1` = must change password at next login |
| `two_fa_enabled` | INTEGER | `1` = OTP email required at login |
| `enabled` | INTEGER | `0` = account disabled (soft-delete) |
| `created_at` | INTEGER | Unix timestamp (ms) |
| `last_seen` | INTEGER | Updated on every message poll |

#### `sessions`
| Column | Type | Notes |
|--------|------|-------|
| `token` | TEXT PK | 32-byte hex random |
| `user_id` | INTEGER FK → users.id | Cascades on delete |
| `created_at` | INTEGER | |
| `expires_at` | INTEGER | 7 days from creation |

#### `otp_tokens`
Stores one-time passwords for 2FA login and invite acceptance.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `user_id` | INTEGER FK → users.id | |
| `token` | TEXT | `tempToken:otp` concatenated |
| `purpose` | TEXT | `'2fa_login'` or `'invite'` |
| `expires_at` | INTEGER | 10 minutes from creation |
| `used` | INTEGER | `1` after first successful use |
| `created_at` | INTEGER | |

#### `messages`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID v4 |
| `user_id` | INTEGER FK → users.id | |
| `text` | TEXT | Message body (may be empty if media-only) |
| `image_path` | TEXT | Relative URL e.g. `/uploads/<uuid>.jpg` |
| `view_once` | INTEGER | `1` = view-once message |
| `is_blurred` | INTEGER | `1` = image shown blurred until tapped |
| `reply_to_id` | TEXT | UUID of quoted message |
| `reply_user` | TEXT | Display name of quoted author |
| `reply_text` | TEXT | Snippet of quoted text |
| `created_at` | INTEGER | Timestamp used for ordering |
| `submitted_at` | INTEGER | Client-supplied timestamp (within ±5 min tolerance) |
| `deleted_at` | INTEGER | Soft-delete timestamp |
| `deleted_by` | INTEGER FK → users.id | Who deleted it |

#### `message_views`
Records when a user opens a view-once message. Composite primary key prevents double-recording.

| Column | Type | Notes |
|--------|------|-------|
| `message_id` | TEXT FK → messages.id | |
| `user_id` | INTEGER FK → users.id | |
| `viewed_at` | INTEGER | |

#### `reports`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `message_id` | TEXT FK → messages.id | |
| `reported_by` | INTEGER FK → users.id | |
| `reported_at` | INTEGER | |
| `reviewed` | INTEGER | `0` = pending, `1` = reviewed |
| `reviewed_by` | INTEGER FK → users.id | Admin who reviewed |
| `reviewed_at` | INTEGER | |
| `action_taken` | TEXT | Free-text note from reviewing admin |

#### `user_preferences`
Per-user UI settings.

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | INTEGER PK FK → users.id | |
| `colour_scheme` | TEXT | Selected built-in colour palette id |
| `enter_to_send` | INTEGER | `1` = Enter key submits the form |
| `push_enabled` | INTEGER | User's persisted preference for push notifications on their account |
| `font_size` | INTEGER | Chat message font size in pixels |
| `font_family` | TEXT | Selected built-in font id (`system`, `serif`, `friendly`) |
| `updated_at` | INTEGER | |

#### `app_settings`
Key/value store for admin-configurable settings.

| Key | Default | Description |
|-----|---------|-------------|
| `pwa_enabled` | `'0'` | Enable PWA manifest and service worker |
| `push_notifications_enabled` | `'0'` | Allow installed PWA clients to opt in to push notifications |
| `available_colour_schemes` | All built-ins | Comma-separated palette ids exposed to end users |
| `default_font_family` | `'system'` | Default chat font for users without a personal font choice |
| `chat_icon_url` | unset | Current processed app/chat icon URL, set by the admin icon upload endpoint |
| `report_enabled` | `'0'` | Show report button on received messages |
| `site_title` | `'Messaging'` | Browser tab title and app name |
| `main_header` | `'Messaging'` | Chat header text (also the emergency-exit trigger) |
| `enable_view_once` | `'1'` | Show view-once option on media uploads |
| `enable_blur` | `'1'` | Show blur option on media uploads |
| `enable_emergency_exit` | `'1'` | Enable header-click emergency exit |
| `enable_delete_button` | `'1'` | Show delete button on own messages |
| `delete_button` | `'✗'` | Delete button label |
| `reply_button` | `'↩'` | Reply button label |
| `read_status_seen` | `'✓✓'` | Read receipt: seen |
| `read_status_unread` | `'✓'` | Read receipt: delivered |

---

## 6. Authentication & Session Flow

### 6.1 Standard Login

```
Client                                Server
  │                                      │
  │── POST /api/auth/login ─────────────▶│
  │   { username, password,              │  1. Verify Turnstile token (if configured)
  │     turnstileToken }                 │  2. Look up user by username
  │                                      │  3. Verify scrypt hash
  │◀── 200 { status:'ok', user:{...} } ──│  4. Set session cookie (HttpOnly, SameSite=Strict)
  │                                      │
```

If `two_fa_enabled = 1` and the user has an email address:

```
  │◀── 200 { status:'2fa_required',      │  4a. Generate 6-digit OTP + tempToken
  │          tempToken }                 │  5a. Store tempToken:OTP in otp_tokens
  │                                      │  6a. Send OTP to user's email
  │── POST /api/auth/verify-otp ────────▶│
  │   { tempToken, otp }                 │  7a. Match tempToken:OTP (timing-safe equal)
  │◀── 200 { status:'ok', user:{...} } ──│  8a. Mark OTP used; create session
```

If `force_password_change = 1`, the login response returns `status: 'change_password'` and the frontend forces the user through the password-change step before granting access to the chat.

### 6.2 Session Cookie

- Token: 32 cryptographically random bytes encoded as 64-char hex
- Set as: `session=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`
- Sessions expire after 7 days; the DB cleanup interval runs hourly
- `resolveSession(token)` queries `sessions JOIN users` in a single round-trip

### 6.3 Password Hashing

`crypto.scrypt(password, randomSalt16bytes, 64)` → stored as `<hex-salt>:<hex-hash>`.  
Comparison uses `crypto.timingSafeEqual` to prevent timing attacks.

### 6.4 OTP

- 6-digit integer from `crypto.randomInt(100000, 999999)`
- `tempToken`: 32 random bytes hex — opaque to the client, identifies the pending OTP row
- Stored as `tempToken:OTP` in a single column; both fields must match
- Valid for 10 minutes; single-use; consumed on first successful verification

---

## 7. API Endpoints

API responses are JSON except downloadable database/post exports. Authentication errors return HTTP 401; authorisation errors return 403.

### Auth — `/api/auth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/login` | None | Authenticate with username + password (+ optional Turnstile). Returns session cookie or triggers 2FA flow. |
| POST | `/verify-otp` | None | Submit OTP code. Returns session cookie on success. |
| POST | `/logout` | None | Deletes the session record and clears the cookie. |
| POST | `/change-password` | Session | Changes the current user's password. Requires `currentPassword` and `newPassword`. |

### Messages — `/api`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/me` | Session | Returns `{ user, role, forcePasswordChange, twoFaEnabled }`. |
| GET | `/config` | None | Returns public site configuration from `app_settings`, including app name, palette/font options, PWA/push flags, icon URL, app version, and Turnstile site key. |
| GET | `/messages` | Session | Returns `{ posts, total, typing, lastSeen }`. Supports `?limit=N&before=<timestamp>`. Updates `users.last_seen`. |
| POST | `/messages` | Session | Create a new message. Accepts `multipart/form-data` with optional `image` file. Fields: `text`, `viewOnce`, `isBlurred`, `replyUser`, `replyText`, `replyId`, `submittedAt`. |
| DELETE | `/messages/:id` | Session | Soft-deletes a message. Own messages only; admins can delete any. |
| POST | `/messages/:id/view` | Session | Marks a view-once message as viewed (inserts into `message_views`). Returns `{ imagePath }`. |
| POST | `/messages/:id/report` | Session | Reports a message (requires `report_enabled = '1'`). |
| POST | `/typing` | Session | Sets typing state: `{ isTyping: boolean }`. |
| GET | `/preferences` | Session | Returns `{ scheme, enterToSend, pushEnabled, fontSize, fontFamily }`. |
| POST | `/preferences` | Session | Saves `{ scheme?, enterToSend?, pushEnabled?, fontSize?, fontFamily? }`. |

### Admin — `/api/admin`

All routes require `role = 'admin'`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/users` | List all users (id, username, display_name, email, role, flags, timestamps). |
| POST | `/users` | Create a new user. Body: `{ username, displayName, password, email?, role? }`. |
| PATCH | `/users/:id` | Update user fields: `displayName`, `email`, `role`, `enabled`, `twoFaEnabled`, `forcePasswordChange`, `newPassword`. |
| DELETE | `/users/:id` | Soft-disables a user (`enabled = 0`). Cannot delete the last active admin. |
| POST | `/invite` | Sends an invite email with a temporary OTP. Body: `{ userId }`. |
| GET | `/reports` | List all reports with joined message and user data. |
| PATCH | `/reports/:id` | Mark a report reviewed. Body: `{ actionTaken? }`. |
| GET | `/settings` | Get all `app_settings` values. |
| PATCH | `/settings` | Update one or more `app_settings` values. |
| POST | `/icon` | Uploads a JPG, PNG, or WebP icon and generates compliant favicon, Apple touch icon, standard PWA icons, and maskable PWA icons. |
| POST | `/import/preview` | Preview a legacy `posts.json` import and return suggested user mappings. |
| POST | `/import/commit` | Commit a previewed import with admin-selected mappings. Returns `{ imported, skipped, createdUsers }`. |
| GET | `/database/status` | Pending restore status, restart availability, and upload size limit. |
| GET | `/database/export` | Downloads a consistent encrypted `.db` snapshot, including committed WAL data. |
| POST | `/database/validate` | Multipart field `database` (256 MiB maximum); checks key, integrity, foreign keys, schema and enabled admin; returns `validationToken`, `users`, `admins`, `expiresInSeconds`. |
| POST | `/database/restore` | JSON `{ validationToken, password, confirm: "RESTORE" }`; stages the validated backup for next startup. |
| DELETE | `/database/restore` | JSON `{ password }`; cancels the pending restore. |
| POST | `/database/restart` | JSON `{ password, confirm: "RESTART" }`; returns 202 then exits gracefully for the supervisor to relaunch. Disabled unless `ADMIN_RESTART_ENABLED=true`. |

### Infrastructure

| Method | Path | Description |
|--------|------|-------------|
| GET | `/readyz` | Health-check. Returns `{ ok, service, version, timestamp }`. No authentication required. |
| GET | `/sw.js` | Service worker (only served when `pwa_enabled = '1'`). Version placeholder replaced at runtime. `Cache-Control: no-cache`. |
| GET | `/manifest.json` | PWA manifest (only served when `pwa_enabled = '1'`). |

---

## 8. Feature Specifications

### 8.1 Real-time Polling

The frontend polls `GET /api/messages` every 2 seconds. Each response contains:

- `posts`: array of message objects visible to the user (up to `limit`, ordered ascending by `created_at`)
- `typing`: array of display names currently typing (updated via `POST /api/typing`, stale after 5 s)
- `lastSeen`: map of `display_name → last_seen_timestamp` for all users

New messages are appended to the DOM without re-rendering existing ones. Soft-deleted messages are removed from the DOM when their timestamp falls within the fetched window.

### 8.2 Infinite Scroll / History

Older messages are loaded on demand via `GET /api/messages?limit=30&before=<timestamp>` as the user scrolls to the top. A `ResizeObserver` and `IntersectionObserver` on a sentinel element manage automatic loading. The viewport scroll position is restored after prepending older messages.

### 8.3 Optimistic Pending Bubbles

When a message is submitted, a "pending" bubble is shown immediately in the user's colour with a progress bar fed by `XMLHttpRequest.upload.onprogress`. If the picker contains multiple selected files, the client queues one pending bubble and one `/api/messages` POST per file, preserving the existing single-media message contract. On success each bubble is replaced by the server-confirmed message returned by the next poll. On failure a retry/cancel UI appears.

### 8.4 View-Once Messages

A view-once message contains media that can only be viewed once by the recipient.

**Send flow:**
1. Sender ticks the 👁️ checkbox before submitting.
2. `view_once = 1` is stored in the database.
3. The sender sees: `"👁️ View Once — Delivered / Opened"` (status updates on poll).

**Receive flow:**
1. Recipient sees an active button: `"👁️ View Once Photo/Video"`.
2. On click, `POST /api/messages/:id/view` inserts a `message_views` row.
3. The image overlay is shown immediately.
4. Subsequent polls return `seenBy` containing the recipient's name.
5. The button changes to `"👁️ Photo/Video Viewed"` (dead state, not clickable).

**Import:**
When importing a `posts.json` file with `viewOnce: true` and a `seenBy` array, the import handler also inserts `message_views` rows so the viewed state is faithfully restored.

### 8.5 Blur

Images can be uploaded with a blur overlay. The blur is stored as `is_blurred = 1`. The frontend applies CSS `filter: blur(16px)` to the thumbnail; clicking removes the blur until the next load.

### 8.6 Reply / Quoted Messages

A reply stores `reply_to_id`, `reply_user`, and `reply_text` (a text snippet from the original message). The frontend renders a quoted block above the reply text. Tapping the quoted block scrolls to and highlights the original message, loading older history if needed.

### 8.7 Swipe to Reply

On touch devices, swiping a message bubble more than 60 px to the right (with haptic feedback at the threshold) activates the reply composer.

### 8.8 Read Receipts

The `last_seen` timestamp of each user is updated on every `GET /api/messages` call (unless `?active=false`). The frontend computes per-message read status by comparing `message.created_at` against `otherUser.last_seen`. The `✓` / `✓✓` symbols are configurable via `app_settings`.

### 8.9 Typing Indicator

`POST /api/typing { isTyping: true/false }` writes to an in-memory `Map<displayName, timestamp>` on the server. Stale entries (> 5 s) are pruned on each `GET /api/messages` call. After 4 s of inactivity the client sends `isTyping: false`.

### 8.10 Emergency Exit

Clicking the main header title triggers `emergencyExitNow()`:
1. Sends `POST /api/auth/logout` with `keepalive: true` to invalidate the session.
2. Clears `document.body.innerHTML` and sets background to white.
3. Navigates to `https://www.google.com/search?q=cromer+weather+forecast`.

Controlled via the `enable_emergency_exit` app setting.

### 8.11 Colour Schemes

Ten built-in themes are available: Default, Ocean, Purple, Warm, Forest, Midnight, Rose, Sage, Steel, and Sunset. Applied via CSS custom properties. The admin panel controls which palette ids are exposed to end users through `available_colour_schemes`; preference saves reject disabled or unknown schemes. The active scheme is persisted in `user_preferences.colour_scheme` and restored on load, falling back to the first enabled palette if the saved scheme is no longer available.

### 8.12 Fonts

Users can choose between three built-in font stacks: Default Sans, Serif, and Friendly. Friendly uses a Comic Sans-style system stack (`Comic Sans MS`, then compatible cursive/sans fallbacks). The admin panel controls the default font for users who have not saved a personal choice through `default_font_family`; saved user choices are stored in `user_preferences.font_family`.

### 8.13 In-App Video Recorder

The `🎥` button opens a full-screen recorder using `MediaRecorder` (WebRTC). Maximum recording time is 60 seconds. The recording is submitted directly as a file to `POST /api/messages`. Optional FFmpeg WASM compression uses the locally bundled `@ffmpeg/ffmpeg` 0.12.15 and `@ffmpeg/core` 0.12.10 assets in `public/vendor/ffmpeg`.

---

## 9. File Upload Handling

### Accepted Types

Images: `image/jpeg`, `image/png`, `image/gif`, `image/webp`  
Videos: `video/mp4`, `video/webm`, `video/x-matroska`, `video/quicktime`

Maximum file size: **100 MB** (enforced by multer).

The browser media picker allows multiple files. Each selected file is sent as its own message through the existing `POST /api/messages` endpoint; the database still stores one media path per message.

### Image Processing (sharp)

Uploaded images are processed in memory via `sharp`:
1. Auto-rotate based on EXIF orientation (`sharp.rotate()`)
2. Resize to fit within 2000×2000 px without enlargement
3. Re-encode as JPEG at quality 85
4. Written to `uploads/<uuid>.jpg`

### Video Handling

Videos bypass sharp and are written directly to `uploads/<uuid>.mp4` (or `.webm` for WebM/MKV uploads).

### Upload Security

- Files are stored under a random UUID filename; the original name is discarded.
- The `/uploads/` route is session-gated: a valid session cookie is required to retrieve any uploaded file.
- The MIME type is checked before accepting the upload; only the listed types are permitted.

---

## 10. Rate Limiting

TLS uses a custom in-memory sliding-window rate limiter (`lib/rateLimiter.ts`). No external dependency is required. Each call to `rateLimiter({ windowMs, max })` creates an independent store.

| Route / Context | Window | Max requests |
|----------------|--------|-------------|
| `POST /api/auth/login` | 15 min | 10 |
| `POST /api/auth/verify-otp` | 10 min | 5 |
| `POST /api/auth/change-password` | 15 min | 10 |
| `GET /admin` | 1 min | 30 |
| `GET /manifest.json`, `GET /sw.js` | 1 min | 60 |
| `POST /api/messages` | 1 min | 30 |
| All `/api/admin/*` routes | 1 min | 120 |

Rate-limit responses: HTTP 429 with `{ error: "Too many requests…" }`.

> **Note**: The rate limiter uses `req.ip`. If the application runs behind a reverse proxy, configure `app.set('trust proxy', 1)` to ensure `req.ip` reflects the actual client address.

---

## 11. Progressive Web App (PWA)

PWA support is optional and controlled by the `pwa_enabled` app setting. When disabled, `/manifest.json` and `/sw.js` return 404.

### Service Worker

The service worker (`public/sw.js`) implements:

- **Install**: pre-caches the app shell (`/`, `/style.css`, `/script.js`) and generated PWA icon PNGs.
- **Activate**: deletes all caches whose name does not match the current `CACHE_NAME`, ensuring stale assets from previous versions are evicted.
- **Fetch**: network-first for all requests, falling back to cache for shell assets. API calls, uploads, and admin routes bypass the cache entirely.

**Automatic cache busting on deploy**: The server reads `sw.js` at startup and replaces the literal string `tls-__APP_VERSION__` with the actual package version (e.g. `tls-1.6.1`). The browser then sees a changed SW script, triggering an update cycle. The client-side `updatefound` handler reloads the page automatically once the new SW is installed.

### Install + Push Onboarding

- The page links to `/manifest.json` with `crossorigin="use-credentials"`, so browsers can offer a real install flow when `pwa_enabled = '1'` even when manifest access is gated by credentialed edge auth (for example, Cloudflare Access).
- Users are prompted to install the app first; the push toggle is only shown from the installed PWA context (`display-mode: standalone` / home-screen install).
- Push can only be enabled globally when the admin has both turned on the PWA and configured `VAPID_PUBLIC_KEY` plus `VAPID_PRIVATE_KEY`.
- If the admin disables the PWA or push notifications, stored browser subscriptions are cleared so the server stops dispatching notifications immediately.

### Icon

The default app icon starts from `public/icon.svg`, with generated PNG assets for favicon, Apple touch icon, standard PWA icons, and maskable PWA icons. When an admin uploads a JPG, PNG, or WebP in the admin panel, the server processes it with Sharp into fixed PNG outputs (`pwa-icon-192.png`, `pwa-icon-512.png`, `pwa-icon-maskable-192.png`, `pwa-icon-maskable-512.png`, `pwa-icon-180.png`, and related sizes). The manifest is generated dynamically when PWA support is enabled so install surfaces use the current processed icon set.

---

## 12. Admin Panel

The admin panel is served at `/admin` (HTML file-gate: redirects to `/` if not an admin). The admin panel communicates with the `/api/admin/*` endpoints.

### User Management

- Create users with username, display name, password, optional email, and role
- Edit any user attribute including resetting their password
- Soft-disable users (messages are preserved for audit; the user can no longer log in)
- Cannot delete the last active admin account

### Invite

Sends an email to a user containing their username and a 10-minute OTP. The user uses the OTP as their password for the first login and is then required to set a new password.

### Reports

Displays all reported messages with the reporter name, message author, message content, and reviewed status. Admins can mark reports as reviewed with an optional free-text action note.

### Settings

The admin panel exposes app identity, chat controls, PWA/push settings, colour palette availability, default font, and icon upload. Changes take effect immediately. The configured app name is used in the browser title, chat/admin shell, PWA manifest, notification fallback title, and system emails. Icon uploads are processed server-side into the fixed PNG and maskable icon set used by browser and PWA install surfaces.

### Import

Accepts a JSON file (array of post objects). The import handler:
1. Parses the JSON array.
2. Matches each post's `user` field against existing `display_name` values (case-insensitive, trimmed). Matched posts are attributed to the existing user.
3. If no matching user exists, a stub user account is auto-created (username derived from display name, suffixed `_imported`). A temporary random password is generated. These accounts are listed in the response so the admin can distribute credentials.
4. Idempotent: posts with an existing `id` are skipped.
5. View-once viewed state: if the post has `viewOnce: true` and a `seenBy: [...]` array, `message_views` rows are inserted for each named user so the viewed state is faithfully restored.

---

## 13. Security Model

### Database Encryption

The SQLite file is encrypted with SQLCipher (AES-256-CBC). The encryption key is derived from `DB_ENCRYPTION_KEY` using PBKDF2-SHA256 with 100 000 iterations. Without the key the database file is opaque binary data.

### Session Security

- Session tokens are 256-bit cryptographically random values (32 bytes from `crypto.randomBytes`).
- Cookies are `HttpOnly` (not accessible to JavaScript), `SameSite=Strict` (CSRF protection), and gain the `Secure` flag automatically whenever the request is HTTPS.
- Sessions expire after 7 days and are cleaned up hourly.

### Password Security

Passwords are hashed with `crypto.scrypt` using a random per-user salt. The comparison uses `crypto.timingSafeEqual` to prevent timing oracle attacks.

### Access Control

- All `/api/*` routes (except `/api/config` and `/api/auth/login`) require a valid session.
- All `/api/admin/*` routes additionally require `role = 'admin'`.
- The `/uploads/` directory requires a valid session; files are not publicly accessible.

### CAPTCHA

Cloudflare Turnstile is optionally integrated on the login form. When `TURNSTILE_SECRET_KEY` is set, every login attempt requires a valid Turnstile challenge response verified server-side.

### Headers

`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` are set globally (required for SharedArrayBuffer used by FFmpeg WASM video compression). Consider adding `helmet` for a full defensive header set in production.

---

## 14. Data Flows

### 14.1 Login Flow

```
Browser                                     Server                          DB
   │                                            │                           │
   │── POST /api/auth/login ──────────────────▶ │                           │
   │                                            │── SELECT * FROM users ──▶ │
   │                                            │◀─ user row ───────────── │
   │                                            │── scrypt verify ──────────│
   │                                            │── INSERT INTO sessions ──▶│
   │◀── Set-Cookie: session=<token>; ... ─────  │                           │
   │◀── 200 { status:'ok', user:{...} } ──────  │                           │
```

### 14.2 Message Send Flow

```
Browser                                     Server                          DB / Disk
   │                                            │                           │
   │── POST /api/messages (FormData) ─────────▶ │                           │
   │                                            │── resolve session ───────▶│
   │                                            │── sharp (if image) ───────│── write uploads/<uuid>.jpg
   │                                            │── INSERT INTO messages ──▶│
   │◀── 201 { success:true } ─────────────────  │                           │
   │                                            │                           │
   │── GET /api/messages ─────────────────────▶ │                           │
   │                                            │── SELECT messages JOIN ──▶│
   │◀── 200 { posts:[...] } ──────────────────  │                           │
```

### 14.3 View-Once Flow

```
Browser (recipient)                         Server                          DB
   │                                            │                           │
   │── POST /api/messages/:id/view ───────────▶ │                           │
   │                                            │── INSERT message_views ──▶│
   │◀── 200 { imagePath:'/uploads/...' } ─────  │                           │
   │                                            │                           │
   │ (overlay shows the image)                  │                           │
   │                                            │                           │
   │── GET /api/messages ─────────────────────▶ │                           │
   │                                            │── SELECT seenBy ─────────▶│
   │◀── post.seenBy includes recipient ───────  │                           │
   │ (button changes to "Photo Viewed")         │                           │
```

---

## 15. Deployment

### 15.1 32-bit Raspberry Pi Debian / Raspberry Pi OS 11 or newer

The deployment target is **Debian / Raspberry Pi OS 11 or newer, 32-bit armhf userland, ARMv7 or newer CPU, glibc >= 2.31, and Node.js 22**. This includes Raspbian 11 (Bullseye) with glibc 2.31. Pi 2/3/4/5 and Zero 2 class hardware with a compatible 32-bit OS are appropriate; original Pi 1 / Zero / Zero W ARMv6 hardware is outside this dependency target. A 64-bit kernel on 32-bit userland is possible: use `getconf LONG_BIT`, `dpkg --print-architecture`, and Node's `process.arch` rather than relying solely on `uname -m`.

Node 22 lists Linux ARMv7 as Tier 1; Node 24 downgraded it to experimental. This repository selects Node 22 in `.nvmrc` and its installation/start checks require Node 22 on Linux ARM32. On other hosts the accepted runtime range is Node 22 through 26. Debian 13's standard `nodejs` package is Node 20, which does not meet this project's declared runtime. Install a maintained Node 22 ARMv7 build explicitly. See the [Node 22 support table](https://github.com/nodejs/node/blob/v22.x/BUILDING.md#platform-list), [Node 24 migration notes](https://nodejs.org/en/blog/migrations/v22-to-v24), and [Debian 13 nodejs package](https://packages.debian.org/trixie/nodejs).

Dependency assessment for the locked versions:

Sharp is deliberately pinned to 0.34.5 for Bullseye's glibc 2.31. Its bundled image libraries have known high-severity advisories (reported by `npm audit`), fixed by Sharp 0.35.5, whose ARM32 binary requires glibc 2.36. This is a compatibility tradeoff for the existing server; upgrading the OS and restoring a patched Sharp release remains the security remediation. Do not mix a newer Sharp binding with older libvips binaries.

| Dependency | Version / target | ARM32 requirements |
|---|---|---|
| Database driver on Linux ARM32 | `@tls/sqlite-arm32` → 12.9.0 | Native Linux ARM prebuild for Node 22; keep the exact pin. SQLCipher is bundled; do not substitute Debian's ordinary SQLite binding. The local package is restricted to Linux ARM32 and is skipped on other hosts. |
| Database driver on supported 64-bit hosts | `better-sqlite3-multiple-ciphers` 13.0.3 | Node-API binaries for Node 22–26 on Windows/Linux/macOS x64 and ARM64. Linux glibc builds require glibc >= 2.35. No ARMv7 binary; the shared loader selects the legacy Pi driver instead. |
| `sharp` | 0.34.5 | `@img/sharp-linux-arm` 0.34.5 plus `@img/sharp-libvips-linux-arm` 1.2.4. This ARM libvips build requires glibc >= 2.31 and supports Bullseye with Node 22. Keep the exact pin and optional dependencies installed. |
| `dotenv`, `express`, `multer`, `nodemailer`, `web-push` | Locked 18.0.9 / 5.3.0 / 2.5.0 / 10.2.1 / 3.6.7 | JavaScript dependencies compatible with Node 22; no additional target-specific native module in their locked dependency trees. Crypto/TLS use Node's built-in implementation. |
| `tsx` / `esbuild` | 4.23.15 / 0.28.2 | esbuild ships `@esbuild/linux-arm`; install its optional binary and allow its install script. Needed by `npm start`, maintenance CLI and tests. |
| `typescript` | 7.0.2 | Native compiler ships `@typescript/typescript-linux-arm`; install optional dependencies even for build-only use. |
| `@types/*`, including `@types/node` 22.x | Locked development definitions | No native runtime; Node definitions match the Pi's Node 22 API baseline. |
| Browser FFmpeg assets in `public/vendor/ffmpeg/` | JavaScript / WebAssembly | Execute in the client's browser, not as a server ARM executable. No server `ffmpeg` package is required. Browser memory and SharedArrayBuffer support still apply. |

The native support is documented in the [Pi database release](https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/tag/v12.9.0), [Node-API database release](https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/tag/v13.0.3), [Sharp installation guide](https://sharp.pixelplumbing.com/install/), [ARM libvips manifest](https://github.com/lovell/sharp-libvips/blob/v1.2.4/npm/linux-arm/package.json), and [esbuild ARM manifest](https://github.com/evanw/esbuild/blob/v0.28.2/npm/@esbuild/linux-arm/package.json). Architecture-specific compiler entries can also be inspected directly in `package-lock.json`. The lockfile includes platform alternatives; npm selects only those appropriate for the target. Do not replace the pins with `latest` without rechecking ARM32 support.

Verify the machine first:

```bash
cat /etc/os-release
dpkg --print-architecture       # armhf
getconf LONG_BIT                # 32
getconf GNU_LIBC_VERSION        # glibc >= 2.31
```

If Node 22 is not already installed, the following installs the latest official Node 22 ARMv7 tarball into a dedicated prefix. Run this on the Pi, not on the Windows development workstation. If a Node version manager is already installed, `nvm install` / `nvm use` from the project directory uses `.nvmrc` instead.

```bash
sudo apt update
sudo apt install -y ca-certificates curl xz-utils python3 make g++ pkg-config fonts-dejavu-core
tls_node_tmp=$(mktemp -d)
cd "$tls_node_tmp"
curl --fail --location --remote-name https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
tls_node_archive=$(awk '$2 ~ /-linux-armv7l.tar.xz$/ {print $2}' SHASUMS256.txt)
test -n "$tls_node_archive"
curl --fail --location --remote-name "https://nodejs.org/dist/latest-v22.x/$tls_node_archive"
awk '$2 ~ /-linux-armv7l.tar.xz$/ {print}' SHASUMS256.txt > SHASUMS-arm.txt
sha256sum --check SHASUMS-arm.txt
# Continue only if the download and checksum succeeded.
sudo mkdir -p /opt/tls-node22
sudo tar -xJf "$tls_node_archive" -C /opt/tls-node22 --strip-components=1
export PATH="/opt/tls-node22/bin:$PATH"
node --version                 # v22.x
node -p 'process.platform + "/" + process.arch'  # linux/arm
```

Keep this Node 22 installation updated with maintenance/security releases. The compiler packages above are fallback prerequisites if a database prebuild cannot be downloaded; the usual installation uses prebuilds. A source build can take substantial memory/time on a Pi. Avoid globally installing `libvips-dev` just for this app: use Sharp's bundled libvips, since Debian's libvips may be older than Sharp's required version. If a global libvips interferes, set `SHARP_IGNORE_GLOBAL_LIBVIPS=1` while installing. `fonts-dejavu-core` supplies predictable fonts for SVG/text rendering; no X11/desktop is needed.

Install into a fresh project checkout on the target using the committed lockfile:

```bash
cd /srv/tls
export PATH="/opt/tls-node22/bin:$PATH"
npm ci --include=dev --include=optional
npm run check:platform -- --raspberry-pi
npm run typecheck
npm run test:database
# Configure .env, then:
npm start
```

Do not use `--omit=optional`, `--ignore-scripts`, or copy `node_modules` from Windows, ARM64, x64, or a different Node major. Install development dependencies because this project's start and database commands use `tsx`; TypeScript 7's native compiler and esbuild also need their target binaries. Package managers that enforce `allowScripts` must allow the Pi's 12.9.0 driver and esbuild install hooks. Version 13 already bundles its binaries and does not need an install-time rebuild; its approval entry is deliberately false. If using another package manager, apply its own build-approval rules.

Keep `platform/sqlite-arm32/` and `.npmrc` in deployment checkouts: npm packs the local optional package using `install-links=true`, installs it only on Linux ARM32, and installs its nested native dependency at version 12.9.0. If that optional install fails, the platform check reports the missing Pi driver and startup stops; it never silently switches the Pi to an unsupported driver or an unencrypted database. The v13 package is installed on all hosts but is not loaded on the Pi. All application, maintenance, verification and recovery snippets must use `lib/sqlite-driver.cjs` rather than importing the modern package directly on ARM32.

`check:platform -- --raspberry-pi` fails unless run on the actual Linux ARM32 Debian / Raspberry Pi OS 11 or newer host. It checks the runtime/OS/glibc baseline, loads the JavaScript dependencies, creates and reopens a disposable encrypted SQLite WAL database, processes SVG/PNG/WebP/JPEG through Sharp, runs the native TypeScript compiler, and exercises tsx/esbuild. It never opens the production database or loads `.env`. Missing binaries, wrong Node ABI, and missing shared libraries are reported as failures. A metadata review or a passing Windows test does not replace this target-host check; hardware execution has to be confirmed on the Pi.

For systemd, configure `WorkingDirectory=/srv/tls`, `Environment=PATH=/opt/tls-node22/bin:/usr/local/bin:/usr/bin:/bin`, and `ExecStart=/opt/tls-node22/bin/node /srv/tls/node_modules/tsx/dist/cli.mjs /srv/tls/server.ts`. This ensures the service and subprocesses use the selected Node 22 rather than Debian's Node 20. Preserve the existing service user, `.env`, permissions and restart policy. The PATH must also be used for maintenance commands. After a Node major or architecture change, reinstall from the lockfile before restarting.

### 15.2 Node 22–26 on other hosts

For supported x64/ARM64 Windows, Linux and macOS hosts, select the desired Node version (22, 24 or 26 recommended), then install from the lockfile. The old Node 22/24-only restriction has been replaced with `>=22 <27`; this also accepts intermediate Node 23/25 releases, though maintained LTS lines are preferred. Future Node majors require verification before widening the declared range.

```bash
# With an existing nvm installation, for example:
nvm install 26
nvm use 26
npm ci --include=dev --include=optional
npm run check:platform
npm run typecheck
npm run test:database
npm run test:server
npm start
```

Stop a running local service before replacing its `node_modules`, especially on Windows where loaded native DLLs are locked. Use a separate checkout for testing another runtime while production remains online. Keep the service's explicit Node executable/PATH consistent with the version chosen for installation. `.nvmrc` stays at 22 for the Pi/default baseline and does not prohibit explicitly selecting 26 on other hosts.

The database key derivation and cipher pragmas are unchanged. Existing 12.9.0 encrypted databases remain readable by the modern driver, and compatibility testing covers encrypted read/write round trips in both directions. Back up the database, media and original key before upgrading, and test a copy first. A Node runtime upgrade alone does not require decrypting/re-encrypting or resetting user passwords. Do not open the same database concurrently from separate deployments/drivers.

The `Node compatibility` GitHub Actions workflow performs clean installation, platform checks, typechecking, compilation, admin recovery tests, and full server startup/login/export tests on Node 22, 24 and 26 for Windows and Linux. Its Node 22 Linux job also installs an isolated 12.9.0 driver to check encrypted-file interoperability with version 13. These checks do not replace running `check:platform -- --raspberry-pi` on the physical Pi.

### Quick Start (development)

```bash
cp .env.example .env
# Fill in DB_ENCRYPTION_KEY, ADMIN_USERNAME, ADMIN_PASSWORD
npm ci --include=dev --include=optional
npm run check:platform
npm start        # tsx server.ts; use npm run dev for file watching
```

### Production

```bash
npm run build    # tsc → dist/
node dist/server.js
```

Serve TLS over HTTPS directly or via a trusted reverse proxy so session cookies can be marked `Secure`.

### Reverse Proxy (nginx example)

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3333;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

When behind a proxy, set `TRUST_PROXY=1` (or another valid Express trust-proxy value) so that `req.ip` reflects the real client address, rate limiting works correctly, Turnstile receives the correct client IP, and HTTPS requests terminated at the proxy still receive `Secure` session cookies.

### Health Check

```bash
curl https://chat.example.com/readyz
# {"ok":true,"service":"Messaging","version":"1.6.1","timestamp":"2026-05-04T..."}
```

### Data Backup

Use the admin Database export or the maintenance command described in section 16. Do not copy a running SQLite main file with `cp`: recently committed data can still be in its WAL. Keep the original `DB_ENCRYPTION_KEY` separately secured. The database file alone cannot be recovered without the key.

```bash
npm run database -- export /secure/backups/tls-backup.db
```

### File Storage

Uploaded media is stored in the `uploads/` directory. This directory must be backed up alongside the database to preserve message attachments. It is excluded from source control (`.gitignore`).

## 16. Database Export, Restore and Admin Recovery

### 16.1 Scope and prerequisites

The **Database** tab appears only in the protected admin panel. All database HTTP routes sit under `/api/admin/database`, behind the existing session, enabled-account, admin-role and CSRF checks. Accounts with a required password change must change it first. An adult or ordinary user cannot use these endpoints. Unsafe requests must include `X-CSRF-Token` obtained through the signed-in session's `/api/auth/csrf` endpoint. Restore, cancellation and restart additionally require the current administrator password and are limited to five attempts per minute per IP, within the admin router's existing limit.

Exports contain the entire encrypted database: accounts, password hashes, messages, settings, reports and other database records. They are distinct from the existing posts JSON export. Protect them as sensitive backups. Store the original `DB_ENCRYPTION_KEY` in a separate secure location; neither this tool nor an admin password reset can recover a lost encryption key. Restore accepts databases readable using the server's current key and this release's required schema. Migrate older backups in an isolated installation first; do not assume a backup from another release is compatible.

A database export does **not** contain `uploads/`, custom icons in `public/`, `.env`, TLS/proxy configuration, application code or dependencies. Preserve these separately, together with the deployed app version. Take a coordinated filesystem backup with the service stopped if media and database must represent exactly the same moment. Use a single application process per database; stop every process/container that opens the database before offline restore or account reset. The `--server-stopped` flag is an operator acknowledgement, not automatic process detection.

`DB_PATH` is resolved relative to the working directory, while media and public assets are relative to the running server module. With `npm start`, these are the project `uploads/` and `public/`; when running `dist/server.js`, they are `dist/uploads/` and `dist/public/`. Adjust the archive/restore examples to the paths actually used by your service. Run the maintenance CLI with the same working directory and database environment as that service.

### 16.2 Export and download in the admin panel

1. Sign in as an administrator, complete any required password change, and open **Admin → Database**.
2. Select **Download database export**. Save the dated `.db` file in secure backup storage. The server checkpoints committed WAL data and holds a write lock while copying the encrypted file. If the database is busy, retry during a quieter period. Large snapshots and validation can temporarily delay other requests.
3. Save the matching media, custom icons and server configuration separately. Record the application version and the backup time.
4. Test the downloaded file using **Validate**. Retain the backup only after validation succeeds. Validation tests readability with the current key, SQLite integrity, foreign keys, required tables/columns, absence of unexpected triggers/views, and presence of an enabled admin. It does not prove attachment availability, credential knowledge, or provenance; restore only trusted backups.

The downloaded database remains encrypted. A temporary server-side export is deleted after transfer. Validation uploads are private temporary files, limited to 256 MiB, with a 15-minute, single-use token bound to the validating session. Expired files are cleaned every minute; normal process exit cleans the temporary directory. A forced kill can leave an operating-system temporary directory named `tls-database-*`; remove orphan directories only after confirming no TLS process uses them. Larger backups use the server CLI instead of the web upload path. Set the reverse proxy's upload limit (for nginx, `client_max_body_size 257m;`) and timeouts to accommodate the database plus multipart overhead.

### 16.3 Validate, stage restore, and restart

1. Arrange a maintenance window. Download a fresh export of the current database and preserve current media/configuration before proceeding. Database restore replaces all database records; changes made after the backup will no longer appear in the restored database.
2. Choose the encrypted backup in **Database**, select **Validate**, and inspect the reported user/admin counts. A successful validation does not modify the live database. Wrong-key, damaged, incompatible, and admin-less files are rejected. Selecting a different file requires another validation.
3. Within 15 minutes, enter your **current admin password**, tick the replacement acknowledgement, and select **Stage restore**. The server validates again and stores a private copy beside `DB_PATH`, at `<DB_PATH>.restore-pending`. Only one restore can be pending. This survives a process restart. It has not yet replaced the live database. Writes can still occur until restart and will be absent from the restored snapshot.
4. To abandon it, enter the current admin password and select **Cancel pending restore** before restarting. You may then validate and stage a different file.
5. Restore matching `uploads/` and icons during downtime if needed. Select **Restart**, enter the current admin password if cleared, and confirm, or restart the service from the server. Restart also works when no restore is pending. A successful HTTP 202 means the restart was requested; it does not mean the restored service is ready.
6. On startup, before opening the application database or accepting HTTP requests, the server revalidates the pending file, checkpoints and copies the previous live database to `<DB_PATH>.before-restore-<time>-<uuid>`, prepares a restored copy, removes all sessions, OTP tokens and push subscriptions, validates it, then replaces the database. The pending file is removed after successful replacement. Authentication data from the backup cannot resume old logged-in sessions; users must sign in again and register push notifications again. The retained recovery file includes pre-restore credentials/sessions and needs the same protection as an export.
7. Wait for `/readyz` to return success; inspect server startup logs for the restore result. Sign in with an admin account/password **from the backup**, complete any password-change/2FA requirements, and verify users, settings, recent messages, reports, attachments and view-once state. If credentials are unknown or 2FA mail is unavailable, follow section 16.7.

Ensure enough free space for the live database, upload, pending file, working copy and recovery copy. No pending file is served as a public asset. Keep database directories outside `public/` and restrict filesystem access to the service account and backup operators. If startup validation fails, startup stops rather than serving a partially restored database. Preserve logs and files, stop the service, and inspect `<DB_PATH>.restore-pending`. Move it to secure quarantine to cancel a failed pending restore before starting the prior database. If replacement already happened, use the retained recovery copy via section 16.6. Do not delete recovery copies until the restored installation has been checked and retention policy permits deletion.

### 16.4 Configuring Restart

The Restart option deliberately exits the current Node process with code 0 after its HTTP response completes, allowing up to ten seconds for outstanding connections. It relies on a service supervisor to start a fresh process. It does not execute shell commands, install a supervisor or relaunch itself. Leave `ADMIN_RESTART_ENABLED=false` when running in a terminal; use Ctrl+C followed by `npm start` instead. Avoid a file-watching development runner for production recovery.

For an existing systemd service named `tls`, configure its unit with `Restart=always` and an appropriate `RestartSec` (for example `2`), then reload systemd. `Restart=on-failure` alone does not relaunch a successful exit. For a container, configure a restart policy that includes clean exits. Only after verifying the supervisor, set `ADMIN_RESTART_ENABLED=true` in the service environment and restart normally. The UI then enables Restart. A manually issued `systemctl stop tls` still keeps a systemd service stopped during offline maintenance. Use your actual service name/path in the examples below. Supervisors with retry limits must be monitored after a failed startup.

### 16.5 Manual export and download from the server

Run commands from the project directory, under the service account, with the correct `.env`, `DB_PATH` and original `DB_ENCRYPTION_KEY`. CLI commands load `.env`; existing shell environment variables take precedence. Do not print the key or put passwords on command lines. The CLI uses the same encrypted database library and PBKDF2 key derivation as the application; a generic SQLite CLI cannot open these files with the passphrase alone.

For a consistent encrypted database export while the app is running:

```bash
cd /srv/tls
umask 077
mkdir -p /secure/backups
npm run database -- export /secure/backups/tls-backup.db
npm run database -- validate /secure/backups/tls-backup.db
sha256sum /secure/backups/tls-backup.db
```

Use a unique destination filename: export refuses to overwrite an existing file. Export checkpoints the WAL and acquires a write lock; retry if there are active writers. Validation prints counts on success and returns a nonzero exit code on failure. Do not use a backup that fails validation.

For a coordinated full backup, first stop the service, run the export, and archive `uploads/`, custom icons and configuration into separately protected backup storage. Restart the service after the archive is complete. Example media backup:

```bash
sudo systemctl stop tls
npm run database -- export /secure/backups/tls-offline.db
tar -czf /secure/backups/tls-uploads.tar.gz uploads
# Separately preserve .env, custom public icons, service and proxy configuration.
sudo systemctl start tls
```

From a trusted workstation, download through SSH/SCP; use an account allowed to read these private files, or have the server operator transfer them into a restricted download directory first. Do not make them world-readable or expose them through the web root:

```bash
scp backupuser@server:/secure/backups/tls-backup.db ./tls-backup.db
scp backupuser@server:/secure/backups/tls-uploads.tar.gz ./tls-uploads.tar.gz
sha256sum ./tls-backup.db
# On PowerShell: Get-FileHash ./tls-backup.db -Algorithm SHA256
```

Compare the downloaded checksum with the server checksum. This detects transfer changes; it is not proof that the backup is trustworthy. Keep encryption keys/configuration in separate encrypted storage. If the application cannot start, preserve the main `.db`, its `-wal` and `-shm` files as one stopped-server recovery set before troubleshooting. Never copy only the main file of a running WAL database. Prefer the maintenance export over restoring raw WAL files.

### 16.6 Manual restoration and rollback

1. Transfer the trusted `.db` backup to a private server directory using SCP. Install the matching application release and dependencies. Restore the original key in the service configuration; changing `ADMIN_PASSWORD` does not change existing accounts. Confirm the intended absolute `DB_PATH`; do not inadvertently create a new empty database at another path.
2. Stop the service and every other database writer, and disable any orchestrator that would immediately replace a stopped process. Preserve a complete current backup and matching media/configuration.
3. Run validation, then offline restore. `--server-stopped` confirms you have stopped all processes. These commands never start the HTTP server:

```bash
cd /srv/tls
sudo systemctl stop tls
npm run database -- validate /secure/incoming/tls-backup.db
npm run database -- restore /secure/incoming/tls-backup.db --server-stopped
```

4. Resolve any existing pending restore before using the offline restore command: inspect it and move it to secure quarantine if cancelling it. The CLI refuses to overwrite a pending restore. Offline restoration uses the same validation, recovery copy and session revocation as startup restoration. If the current database is corrupt and cannot be checkpointed, the automatic safety copy fails and replacement is refused. While fully stopped, preserve the corrupt main file **and its sidecars** in secure quarantine, then retry against the now absent target; retain that quarantine for investigation.
5. Restore matching media to the application's `uploads/` and custom icons to `public/`. Preserve current copies first and check archive paths before extraction. Match ownership and directory/file permissions to the service account. If media was deleted after the backup, a database-only restore cannot recreate it.
6. Start and check the service:

```bash
sudo systemctl start tls
sudo journalctl -u tls -n 100 --no-pager
curl --fail http://127.0.0.1:3333/readyz
```

7. Sign in using backup credentials and complete the functional checks in section 16.3. To roll back, stop the service again, validate the desired `.before-restore-*` recovery file, then pass its path to the same `restore ... --server-stopped` command. Use the separately preserved media/configuration that belongs to that recovery point. A new safety copy will be made and login tokens revoked again.

On Windows use the service manager for the actual service, or stop the foreground Node process. From PowerShell, `Set-Location C:\GitHub\TLS` and the same `npm run database -- ...` commands work. Supply quoted absolute Windows paths. Ensure no second Node process still holds the database open.

### 16.7 Admin account reset

If another administrator can sign in, use **Admin → Users → Edit** to set a new password, enable the account, clear its locked status and adjust 2FA as needed. The user must change the temporary password on next login. If no administrator can sign in, use the offline reset command below. The existing admin username must be known; the command changes only an existing admin and refuses ordinary users or unknown usernames. Changing `.env` `ADMIN_PASSWORD` alone does not reset an existing account: those variables seed an absent account only.

First stop all service processes, preserve a current backup and verify the original database key. Read a temporary password without putting it in shell history. It must contain at least 12 characters and at least three of lowercase, uppercase, digits and symbols.

```bash
cd /srv/tls
sudo systemctl stop tls
read -r -s -p 'Temporary admin password: ' RESET_ADMIN_PASSWORD
echo
export RESET_ADMIN_PASSWORD
npm run database -- reset-admin admin --server-stopped
unset RESET_ADMIN_PASSWORD
sudo systemctl start tls
```

PowerShell equivalent (stop the service first and replace `admin` with the existing username):

```powershell
Set-Location C:\GitHub\TLS
$resetSecret = Read-Host 'Temporary admin password' -AsSecureString
$env:RESET_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $resetSecret).Password
try {
  npm run database -- reset-admin admin --server-stopped
} finally {
  Remove-Item Env:RESET_ADMIN_PASSWORD
  $resetSecret.Dispose()
}
# Start the actual Windows service, or run npm start in the project directory.
```

Check the command's exit code before starting the service. The reset hashes the temporary password with the application's scrypt implementation, enables/unlocks the account, clears failed login counters, disables email 2FA for recovery, requires a password change, and revokes that admin's sessions, OTPs and push subscriptions. It does not print the password or change other accounts. Sign in, immediately change the temporary password, verify SMTP access and re-enable 2FA. Clear the temporary environment variable even after an error and never store it in `.env`. This procedure requires trusted server access and the original database key; it provides no public account-reset endpoint.
