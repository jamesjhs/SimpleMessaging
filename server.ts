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
import { version as APP_VERSION } from './package.json';

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Pre-process sw.js once at startup: inject the real app version into the
// cache-name placeholder so every deploy gets a fresh cache bucket and the
// SW's activate handler automatically evicts the previous version's assets.
const swContent = fs
  .readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8')
  .replace(/tls-__APP_VERSION__/g, `tls-${APP_VERSION}`);

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

// ── Block direct access to admin static files ─────────────────────────────────
// The protected /admin route is the only legitimate entry-point for admin HTML;
// serving admin.html (and its assets) as plain static files would let any
// authenticated or unauthenticated user load the admin shell by URL.
const ADMIN_STATIC = new Set(['/admin.html', '/admin.js', '/admin.css']);
app.use((req: Request, res: Response, next: NextFunction): void => {
  if (ADMIN_STATIC.has(req.path)) {
    const cookies = parseCookies(req);
    const user    = resolveSession(cookies.session);
    if (!user || user.role !== 'admin') {
      res.redirect('/?redirect=admin');
      return;
    }
  }
  next();
});

// ── Public static files ───────────────────────────────────────────────────────
// index.html is served with no-cache so browsers always revalidate and pick up
// new asset fingerprints immediately, even when the Service Worker is bypassed.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res: Response, filePath: string) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ── Protected uploads – session cookie required ───────────────────────────────
app.use('/uploads', (req: Request, res: Response, next: NextFunction): void => {
  const cookies = parseCookies(req);
  const user    = resolveSession(cookies.session);
  if (!user?.enabled) { res.sendStatus(401); return; }
  next();
}, express.static(UPLOADS_DIR));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/readyz', (_req: Request, res: Response): void => {
  res.json({ ok: true, service: 'TLS', version: APP_VERSION, timestamp: new Date().toISOString() });
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
  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(swContent);
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
    console.log(`TLS v${APP_VERSION} listening on http://localhost:${PORT}`);
  });
}).catch((err: Error) => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});
