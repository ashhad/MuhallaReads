import path from 'node:path';

const env = process.env;
const digits = (s) => String(s || '').replace(/\D/g, '');
/** A number setting. Ignores currency signs and spaces ("4$", "$ 4"); anything unreadable uses the default. */
function num(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.replace(/[$₹,\s]/g, ''));
  if (Number.isFinite(n) && n >= 0) return n;
  console.warn(`Setting ${name}="${raw}" is not a number; using ${fallback}.`);
  return fallback;
}

/** A 10-digit Indian-style number (or 0 + 10 digits) gets the default country code, as WhatsApp sends it. */
function withCountryCode(d) {
  const cc = digits(env.DEFAULT_COUNTRY_CODE || '91');
  if (d.length === 10) return cc + d;
  if (d.length === 11 && d.startsWith('0')) return cc + d.slice(1);
  return d;
}

export const config = {
  port: num('PORT', 3000),
  // Set to 127.0.0.1 when a reverse proxy (e.g. Caddy) sits in front, so the app isn't exposed directly.
  host: env.HOST || undefined,
  communityName: env.COMMUNITY_NAME || 'MuhallaReads',
  // Shared code people must send ("join <code>") before they can use the library. Empty = open.
  joinCode: (env.JOIN_CODE || '').trim(),
  // Members (by WhatsApp number, with country code) who can use admin commands.
  // Written with or without the country code ("9812345678" or "919812345678").
  adminPhones: (env.ADMIN_PHONES || '').split(',').map((p) => withCountryCode(digits(p))).filter(Boolean),
  // Added to 10-digit local numbers typed without a country code (admin script).
  defaultCountryCode: digits(env.DEFAULT_COUNTRY_CODE || '91'),
  dbPath: env.DB_PATH || path.join(env.DATA_DIR || 'data', 'muhallareads.db'),
  // Public https URL of the web app, used in sign-in links sent over WhatsApp.
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  timeZone: env.TIME_ZONE || 'Asia/Kolkata',

  // Lending rules
  loanDays: num('LOAN_DAYS', 21),
  maxPendingRequests: num('MAX_PENDING_REQUESTS', 5),

  // WhatsApp cost control: paid "template" notifications per month (≈ ₹0.14 each in India).
  monthlyTemplateLimit: num('MONTHLY_TEMPLATE_LIMIT', 200),
  // Set WHATSAPP_TEMPLATES=off until Meta has approved the templates in docs/whatsapp-templates.md.
  templatesEnabled: (env.WHATSAPP_TEMPLATES || 'on').toLowerCase() !== 'off',

  // Photo recognition (bookshelf / covers / barcodes) via Claude. Optional, and the only feature that
  // costs money per use. Haiku is about ₹0.10 a photo; Sonnet and Opus read busy shelves better but
  // cost roughly 20× and 40× more.
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  claudeModel: env.CLAUDE_MODEL || 'claude-haiku-5-5',
  // Hard limits (see src/photos.js): per member per 24 hours, and for everyone per month.
  photoDailyLimit: num('PHOTO_DAILY_LIMIT', 10),
  photoMonthlyLimit: num('PHOTO_MONTHLY_LIMIT', 300),
  // Anthropic bills in US dollars; costs are shown in rupees at this rate. Raise it (e.g. to 105) to
  // include 18% GST and your card's foreign-exchange fee.
  usdInrRate: num('USD_INR_RATE', 88),
  // Monthly spend cap in rupees. An older PHOTO_MONTHLY_BUDGET_USD setting still works if this isn't set.
  photoMonthlyBudgetInr: env.PHOTO_MONTHLY_BUDGET_INR
    ? num('PHOTO_MONTHLY_BUDGET_INR', 90)
    : env.PHOTO_MONTHLY_BUDGET_USD
      ? num('PHOTO_MONTHLY_BUDGET_USD', 1) * num('USD_INR_RATE', 88)
      : 90,

  googleBooksApiKey: env.GOOGLE_BOOKS_API_KEY || '',

  // WhatsApp Cloud API (Meta).
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v23.0',
    templateLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
    // The bot's own number (digits, with country code), used for "Sign in with WhatsApp" links.
    displayNumber: digits(env.WHATSAPP_DISPLAY_NUMBER),
  },
};

export const visionEnabled = () => Boolean(config.anthropicApiKey);
export const whatsappEnabled = (c = config) => Boolean(c.whatsapp.token && c.whatsapp.phoneNumberId);
