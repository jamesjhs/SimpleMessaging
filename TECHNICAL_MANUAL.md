# TLS — Technical Manual

**Version 0.2.0**  
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
| Runtime | Node.js ≥ 20 |
| Language | TypeScript 6 (strict mode), compiled with `tsc` or run with `tsx` |
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
    └─ /*               public static (index.html, style.css, script.js, icon.svg)
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
| `SMTP_FROM` | Optional | Sender address (default: `TLS <noreply@localhost>`). |
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
| `colour_scheme` | TEXT | `'default'`, `'ocean'`, `'purple'`, `'warm'`, `'forest'` |
| `enter_to_send` | INTEGER | `1` = Enter key submits the form |
| `updated_at` | INTEGER | |

#### `app_settings`
Key/value store for admin-configurable settings.

| Key | Default | Description |
|-----|---------|-------------|
| `pwa_enabled` | `'0'` | Enable PWA manifest and service worker |
| `report_enabled` | `'0'` | Show report button on received messages |
| `site_title` | `'TLS'` | Browser tab title |
| `main_header` | `'TLS'` | Chat header text (also the emergency-exit trigger) |
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

All API responses are JSON. Authentication errors return HTTP 401; authorisation errors return 403.

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
| GET | `/config` | None | Returns public site configuration from `app_settings` and Turnstile site key. |
| GET | `/messages` | Session | Returns `{ posts, total, typing, lastSeen }`. Supports `?limit=N&before=<timestamp>`. Updates `users.last_seen`. |
| POST | `/messages` | Session | Create a new message. Accepts `multipart/form-data` with optional `image` file. Fields: `text`, `viewOnce`, `isBlurred`, `replyUser`, `replyText`, `replyId`, `submittedAt`. |
| DELETE | `/messages/:id` | Session | Soft-deletes a message. Own messages only; admins can delete any. |
| POST | `/messages/:id/view` | Session | Marks a view-once message as viewed (inserts into `message_views`). Returns `{ imagePath }`. |
| POST | `/messages/:id/report` | Session | Reports a message (requires `report_enabled = '1'`). |
| POST | `/typing` | Session | Sets typing state: `{ isTyping: boolean }`. |
| GET | `/preferences` | Session | Returns `{ scheme, enterToSend }`. |
| POST | `/preferences` | Session | Saves `{ scheme?, enterToSend? }`. |

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
| POST | `/import` | Import a legacy `posts.json` file. Accepts `multipart/form-data` with a `file` field. Returns `{ imported, skipped, createdUsers }`. |

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

When a message is submitted, a "pending" bubble is shown immediately in the user's colour with a progress bar fed by `XMLHttpRequest.upload.onprogress`. On success the bubble is replaced by the server-confirmed message returned by the next poll. On failure a retry/cancel UI appears.

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

Five built-in themes: Default, Ocean, Purple, Warm, Forest. Applied via CSS custom properties. The active scheme is persisted in `user_preferences.colour_scheme` and restored on load.

### 8.12 In-App Video Recorder

The `🎥` button opens a full-screen recorder using `MediaRecorder` (WebRTC). Maximum recording time is 60 seconds. The recording is submitted directly as a file to `POST /api/messages`. Optional FFmpeg WASM compression is attempted if the CDN libraries are available.

---

## 9. File Upload Handling

### Accepted Types

Images: `image/jpeg`, `image/png`, `image/gif`, `image/webp`  
Videos: `video/mp4`, `video/webm`, `video/x-matroska`, `video/quicktime`

Maximum file size: **50 MB** (enforced by multer).

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

- **Install**: pre-caches the app shell (`/`, `/style.css`, `/script.js`, `/icon.svg`).
- **Activate**: deletes all caches whose name does not match the current `CACHE_NAME`, ensuring stale assets from previous versions are evicted.
- **Fetch**: network-first for all requests, falling back to cache for shell assets. API calls, uploads, and admin routes bypass the cache entirely.

**Automatic cache busting on deploy**: The server reads `sw.js` at startup and replaces the literal string `tls-__APP_VERSION__` with the actual package version (e.g. `tls-0.2.0`). The browser then sees a changed SW script, triggering an update cycle. The client-side `updatefound` handler reloads the page automatically once the new SW is installed.

### Icon

The app icon is defined as an SVG (`public/icon.svg`: a chat bubble on a dark background). Modern browsers and Android PWAs support SVG icons natively. The `<link rel="icon" type="image/svg+xml">` tag in `index.html` ensures the icon appears in the browser tab.

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

All `app_settings` keys are editable from the admin panel. Changes take effect immediately.

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
- Cookies are `HttpOnly` (not accessible to JavaScript), `SameSite=Strict` (CSRF protection), and should be served over HTTPS (`Secure` flag).
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

### Quick Start (development)

```bash
cp .env.example .env
# Fill in DB_ENCRYPTION_KEY, ADMIN_USERNAME, ADMIN_PASSWORD
npm install
npm start        # tsx server.ts – hot-reloads on file change
```

### Production

```bash
npm run build    # tsc → dist/
node dist/server.js
```

A `process.env.NODE_ENV=production` environment is recommended so that session cookies gain the `Secure` flag automatically.

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

When behind a proxy, add `app.set('trust proxy', 1)` to `server.ts` so that `req.ip` reflects the real client address and rate limiting works correctly.

### Health Check

```bash
curl https://chat.example.com/readyz
# {"ok":true,"service":"TLS","version":"0.2.0","timestamp":"2026-05-04T..."}
```

### Data Backup

Back up the encrypted database file and keep the `DB_ENCRYPTION_KEY` separately secured. The database file alone is useless without the key.

```bash
cp data/tls.db backups/tls-$(date +%Y%m%d).db
```

### File Storage

Uploaded media is stored in the `uploads/` directory. This directory must be backed up alongside the database to preserve message attachments. It is excluded from source control (`.gitignore`).
