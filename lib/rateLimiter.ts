/**
 * lib/rateLimiter.ts
 * Simple in-memory rate limiter using a sliding window.
 * No external dependencies required.
 */

import type { Request, Response, NextFunction } from 'express';

interface RateLimiterOptions {
  windowMs: number;  // Window size in milliseconds
  max:      number;  // Maximum requests per window
  message?: string;  // Error message on rate-limit
}

/**
 * Creates an Express middleware that limits repeated requests from the same IP.
 *
 * @example
 *   router.post('/login', rateLimiter({ windowMs: 15 * 60_000, max: 10 }), handler);
 */
export function rateLimiter({ windowMs, max, message }: RateLimiterOptions) {
  const requests = new Map<string, number[]>();

  // Prune all expired entries every windowMs to bound memory usage
  const pruneInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of requests) {
      const fresh = timestamps.filter(t => t > cutoff);
      if (fresh.length === 0) requests.delete(key);
      else requests.set(key, fresh);
    }
  }, windowMs);

  // Prevent the interval from keeping the process alive
  if (pruneInterval.unref) pruneInterval.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key    = req.ip ?? 'unknown';
    const now    = Date.now();
    const cutoff = now - windowMs;

    const timestamps = (requests.get(key) ?? []).filter(t => t > cutoff);

    if (timestamps.length >= max) {
      res.status(429).json({
        error: message ?? 'Too many requests. Please try again later.',
      });
      return;
    }

    timestamps.push(now);
    requests.set(key, timestamps);
    next();
  };
}
