// Recognises books in a photo (one cover, a stack, a shelf of spines, or barcodes) using Claude.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { normalizeIsbn } from './isbn.js';

const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const PROMPT = `This photo was taken by someone adding their own books to a community library catalogue.
It may show a single book cover, a pile of books, a shelf of spines, or ISBN barcodes.

List every distinct book you can identify. For each one give:
- title: the book's title as printed (fix obvious capitalisation; include the subtitle only if clearly visible)
- author: the author if it is printed or you are confident who wrote it, otherwise ""
- isbn: the ISBN digits if an ISBN is printed and fully legible, otherwise ""

Only include books whose title you can actually read. Do not guess unreadable spines, and do not
list the same book twice. If no books are visible, return an empty list.`;

const SCHEMA = {
  type: 'object',
  properties: {
    books: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          author: { type: 'string' },
          isbn: { type: 'string' },
        },
        required: ['title', 'author', 'isbn'],
        additionalProperties: false,
      },
    },
  },
  required: ['books'],
  additionalProperties: false,
};

// US dollars per million tokens (input, output), for the monthly photo budget. A model missing here is
// counted at the most expensive rate, so the budget errs on the safe side.
const PRICES = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-fable-5-1': [10, 50],
};
const MAX_PRICE = [10, 50];
// Models that accept Anthropic's server-side refusal fallback. Haiku doesn't.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

/** What one response cost, in US dollars, from the token counts Claude reports. */
export function costUsd(models, usage = {}) {
  const [inRate, outRate] = models
    .map((m) => PRICES[m] || MAX_PRICE)
    .reduce((a, b) => (b[1] > a[1] ? b : a)); // after a fallback, count the dearer of the two models
  const input =
    (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * inRate + (usage.output_tokens || 0) * outRate) / 1e6;
}

/** The Messages API request for one photo. */
export function photoRequest(model, mediaType, base64) {
  const params = {
    model,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  };
  if (FALLBACK_MODELS.has(model)) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  return params;
}

let client;

export class VisionError extends Error {}

/**
 * @param {Buffer} buffer image bytes
 * @param {string} mediaType e.g. image/jpeg
 * @returns {Promise<{books: Array<{title: string, author: string, isbn: string|null}>, costUsd: number}>}
 */
export async function identifyBooks(buffer, mediaType) {
  if (!config.anthropicApiKey) throw new VisionError('Photo recognition is not set up on this server.');
  const type = String(mediaType || '').split(';')[0].trim().toLowerCase();
  if (!SUPPORTED_TYPES.has(type)) throw new VisionError('Please send a JPEG, PNG or WebP photo.');
  if (buffer.length > MAX_IMAGE_BYTES) throw new VisionError('That photo is too large (max 5 MB).');

  client ??= new Anthropic({ apiKey: config.anthropicApiKey });

  let response;
  try {
    response = await client.beta.messages.create(photoRequest(config.claudeModel, type, buffer.toString('base64')));
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new VisionError('Too many photos right now — try again in a minute.');
    if (err instanceof Anthropic.APIError) {
      console.error(`Claude API error ${err.status}:`, err.message);
      throw new VisionError('Could not read the photo right now. Please try again later.');
    }
    throw err;
  }

  const cost = costUsd([config.claudeModel, response.model], response.usage);
  const text = response.stop_reason === 'refusal' ? '' : response.content.find((b) => b.type === 'text')?.text;
  let parsed = {};
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    // e.g. cut off at max_tokens: treat as nothing found
  }
  const books = (parsed.books || [])
    .filter((b) => b.title?.trim())
    .map((b) => ({ title: b.title.trim(), author: (b.author || '').trim(), isbn: normalizeIsbn(b.isbn) }));
  return { books, costUsd: cost };
}

/** Parses a data: URL (as sent by the web app) into { buffer, mediaType }. */
export function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mediaType: m[1], buffer: Buffer.from(m[2], 'base64') };
}
