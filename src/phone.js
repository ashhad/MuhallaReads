import { config } from './config.js';

/**
 * Normalizes a phone number to international digits only (WhatsApp's format, e.g. 919812345678).
 * Numbers typed locally (10 digits, or with a leading 0) get DEFAULT_COUNTRY_CODE prepended.
 * Returns null if the result doesn't look like a phone number.
 */
export function normalizePhone(input, defaultCountryCode = config.defaultCountryCode) {
  let raw = String(input || '').trim().replace(/^whatsapp:/i, '');
  const hadPlus = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);
  if (!hadPlus && defaultCountryCode) {
    if (digits.length === 11 && digits.startsWith('0')) digits = defaultCountryCode + digits.slice(1);
    else if (digits.length === 10) digits = defaultCountryCode + digits;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** A wa.me link that opens a WhatsApp chat with `phone`, optionally with a pre-filled message. */
export function waLink(phone, text) {
  return `https://wa.me/${phone}` + (text ? `?text=${encodeURIComponent(text)}` : '');
}
