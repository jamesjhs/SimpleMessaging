'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { initDb }    = require('./db');
const { requireAuth, parseCookies, resolveSession } = require('./lib/auth');
const { getSetting } = require('./db');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();

// ── Security / compatibility headers ─────────────────────────────────────────
// COOP/COEP required for SharedArrayBuffer (FFmpeg WASM video compression)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Protected uploads: session cookie required
app.use('/uploads', (req, res, next) => {
  const cookies = parseCookies(req);
  const user    = resolveSession(cookies.session);
  if (!user || !user.enabled) return res.sendStatus(401);
  next();
}, express.static(UPLOADS_DIR));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/readyz', (req, res) => {
  res.json({ ok: true, service: 'TLS', version: '0.1.0', timestamp: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',  require('./routes/auth'));
app.use('/api',       require('./routes/messages'));
app.use('/api/admin', require('./routes/admin'));

// ── Admin panel HTML (protected) ─────────────────────────────────────────────
app.get('/admin', (req, res) => {
  const cookies = parseCookies(req);
  const user    = resolveSession(cookies.session);
  if (!user || user.role !== 'admin') {
    return res.redirect('/?redirect=admin');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── PWA manifest (only serve if enabled) ─────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  if (getSetting('pwa_enabled') !== '1') {
    return res.status(404).json({ error: 'PWA not enabled' });
  }
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// ── Service worker (only serve if PWA enabled) ────────────────────────────────
app.get('/sw.js', (req, res) => {
  if (getSetting('pwa_enabled') !== '1') {
    return res.status(404).send('');
  }
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[server] unhandled error:', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3333;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`TLS v0.1.0 listening on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});
