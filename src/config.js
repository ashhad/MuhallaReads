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

export const config = {
  port: Number(env.PORT || 3000),
  // Set to 127.0.0.1 when a reverse proxy (e.g. Caddy) sits in front, so the app isn't exposed directly.
  host: env.HOST || undefined,
  communityName: env.COMMUNITY_NAME || 'MuhallaReads',
  // Shared code people must send ("join <code>") before they can use the library. Empty = open.
  joinCode: (env.JOIN_CODE || '').trim(),
  // Members (by WhatsApp number, with country code) who can use admin commands.
  adminPhones: (env.ADMIN_PHONES || '').split(',').map(digits).filter(Boolean),
  // Added to 10-digit local numbers typed without a country code (admin script).
  defaultCountryCode: digits(env.DEFAULT_COUNTRY_CODE || '91'),
  dbPath: env.DB_PATH || path.join(env.DATA_DIR || 'data', 'muhallareads.db'),
  // Public https URL of the web app, used in sign-in links sent over WhatsApp.
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  timeZone: env.TIME_ZONE || 'Asia/Kolkata',

  // Lending rules
  loanDays: Number(env.LOAN_DAYS || 21),
  maxPendingRequests: Number(env.MAX_PENDING_REQUESTS || 5),

  // WhatsApp cost control: paid "template" notifications per month (≈ ₹0.14 each in India).
  monthlyTemplateLimit: Number(env.MONTHLY_TEMPLATE_LIMIT || 200),
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
  photoMonthlyBudgetUsd: num('PHOTO_MONTHLY_BUDGET_USD', 1),

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
