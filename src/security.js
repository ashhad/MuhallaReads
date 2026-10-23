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
 * Counts events per key (an IP address or a member) in fixed windows. Kept in memory, which is
 * plenty for one small server.
 */
function createCounter(windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  const entry = (k) => {
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= now) hits.set(k, (e = { count: 0, reset: now + windowMs }));
    return e;
  };
  return {
    count: (k) => entry(k).count,
    hit: (k) => ++entry(k).count,
    retryAfter: (k) => String(Math.ceil((entry(k).reset - Date.now()) / 1000)),
  };
}

const tooMany = (res, retryAfter, message) => res.set('Retry-After', retryAfter).status(429).json({ error: message });

/** At most `max` requests per `windowMs` for each key. */
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests. Please wait a minute and try again.' }) {
  const counter = createCounter(windowMs);
  return (req, res, next) => {
    const k = key(req);
    if (counter.hit(k) > max) return tooMany(res, counter.retryAfter(k), message);
    next();
  };
}

/**
 * At most `max` *failed* attempts per `windowMs` for each key; successes don't count, so people
 * sharing one IP (mobile networks, a building's Wi-Fi) aren't locked out by each other's sign-ins.
 * The route calls `req.failedAttempt()` when an attempt fails.
 */
export function failureLimit({ windowMs, max, key = (req) => req.ip, message }) {
  const counter = createCounter(windowMs);
  return (req, res, next) => {
    const k = key(req);
    if (counter.count(k) >= max) return tooMany(res, counter.retryAfter(k), message);
    req.failedAttempt = () => counter.hit(k);
    next();
  };
}
