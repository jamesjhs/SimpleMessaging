/**
 * server.ts
 * Entry point: configures Express, mounts routes, and starts the HTTP server.
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path   from 'path';
import fs     from 'fs';
import { initDb, getSetting } from './db';
import { parseCookies, resolveSession } from './lib/auth';
import { rateLimiter } from './lib/rateLimiter';
import authRouter     from './routes/auth';
import messagesRouter from './routes/messages';
import adminRouter    from './routes/admin';

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();

// ── Security / CORS headers ────────────────────────────────────────────────────
// COOP + COEP are required for SharedArrayBuffer (FFmpeg WASM video compression)
app.use((_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('Cross-Origin-Opener-Policy',  'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Public static files ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Protected uploads – session cookie required ───────────────────────────────
app.use('/uploads', (req: Request, res: Response, next: NextFunction): void => {
  const cookies = parseCookies(req);
  const user    = resolveSession(cookies.session);
  if (!user?.enabled) { res.sendStatus(401); return; }
  next();
}, express.static(UPLOADS_DIR));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/readyz', (_req: Request, res: Response): void => {
  res.json({ ok: true, service: 'TLS', version: '0.1.0', timestamp: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',  authRouter);
app.use('/api',       messagesRouter);
app.use('/api/admin', adminRouter);

// ── Admin panel HTML (protected) ──────────────────────────────────────────────
app.get('/admin', rateLimiter({ windowMs: 60_000, max: 30 }), (req: Request, res: Response): void => {
  const cookies = parseCookies(req);
  const user    = resolveSession(cookies.session);
  if (!user || user.role !== 'admin') {
    res.redirect('/?redirect=admin');
    return;
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── PWA manifest (only when enabled) ─────────────────────────────────────────
app.get('/manifest.json', rateLimiter({ windowMs: 60_000, max: 60 }), (_req: Request, res: Response): void => {
  if (getSetting('pwa_enabled') !== '1') {
    res.status(404).json({ error: 'PWA not enabled' });
    return;
  }
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// ── Service worker (only when PWA enabled) ────────────────────────────────────
app.get('/sw.js', rateLimiter({ windowMs: 60_000, max: 60 }), (_req: Request, res: Response): void => {
  if (getSetting('pwa_enabled') !== '1') {
    res.status(404).send('');
    return;
  }
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  console.error('[server] unhandled error:', err instanceof Error ? err.stack : err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3333', 10);

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`TLS v0.1.0 listening on http://localhost:${PORT}`);
  });
}).catch((err: Error) => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});
