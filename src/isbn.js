// ISBN helpers. We store ISBN-13 so the same book scanned as ISBN-10 or EAN-13 matches.

export function isbn10to13(isbn10) {
  const core = '978' + isbn10.slice(0, 9);
  return core + isbn13CheckDigit(core);
}

function isbn13CheckDigit(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

function validIsbn10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
  return sum % 11 === 0;
}

function validIsbn13(s) {
  return /^97[89]\d{10}$/.test(s) && isbn13CheckDigit(s.slice(0, 12)) === s[12];
}

/** Returns a normalized ISBN-13 string, or null if the input isn't a valid ISBN. */
export function normalizeIsbn(input) {
  if (!input) return null;
  const s = String(input).toUpperCase().replace(/[^0-9X]/g, '');
  if (validIsbn13(s)) return s;
  if (validIsbn10(s)) return isbn10to13(s);
  return null;
}

/** True if the whole text looks like an ISBN (allowing spaces/dashes and an "ISBN" prefix). */
export function looksLikeIsbn(text) {
  const t = String(text).trim().replace(/^isbn[:\s-]*/i, '');
  return /^[\d\s-]{9,17}[\dXx]?$/.test(t) && normalizeIsbn(t) !== null;
}
