import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  communityName: env.COMMUNITY_NAME || 'MuhallaReads',
  // Optional shared code people must enter to join. Leave empty for an open catalogue.
  joinCode: (env.JOIN_CODE || '').trim(),
  // Prepended to 10-digit local numbers typed without a country code.
  defaultCountryCode: (env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, ''),
  dbPath: env.DB_PATH || path.join(env.DATA_DIR || 'data', 'muhallareads.db'),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),

  // Photo recognition (bookshelf / covers / barcodes) via Claude. Optional.
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  claudeModel: env.CLAUDE_MODEL || 'claude-opus-5-5',

  googleBooksApiKey: env.GOOGLE_BOOKS_API_KEY || '',

  // WhatsApp Cloud API (Meta). Optional.
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v23.0',
    // The bot's number, shown in the web app as a "chat with the bot" link.
    displayNumber: (env.WHATSAPP_DISPLAY_NUMBER || '').replace(/\D/g, ''),
  },

  // WhatsApp via Twilio. Optional alternative to the Cloud API.
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    from: env.TWILIO_WHATSAPP_FROM || '', // e.g. whatsapp:+14155238886
  },
};

export const visionEnabled = () => Boolean(config.anthropicApiKey);
