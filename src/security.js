// Browser security headers, simple rate limits, and the image hosts the app trusts. No dependencies.

// Where book covers may come from. Open Library redirects cover images to archive.org servers.
const COVER_HOSTS = /^https:\/\/(covers\.openlibrary\.org|[a-z0-9-]+\.archive\.org|books\.google\.com|[a-z0-9-]+\.googleusercontent\.com)\//i;

/** Only covers from the book databases we use, so a crafted cover can't make members' browsers call a stranger. */
export const isAllowedCover = (url) => COVER_HOSTS.test(String(url || ''));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // style="" attributes (cover colours) and the privacy page
  "img-src 'self' data: blob: https://covers.openlibrary.org https://*.archive.org https://books.google.com https://*.googleusercontent.com",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers on every response. HTTPS-only (HSTS) is set by Caddy, which terminates TLS. */
export function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}

/**
 * At most `max` requests per `windowMs` for each key (an IP address or a member). Kept in memory,
 * which is plenty for one small server.
 */
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests. Please wait a minute and try again.' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) hits.set(k, (entry = { count: 0, reset: now + windowMs }));
    if (++entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
