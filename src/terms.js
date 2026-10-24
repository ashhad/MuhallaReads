// The Terms members agree to (public/terms.html). Each agreement is stored with the version, so a
// member who agreed to an older version is asked again.

/** The date of the current public/terms.html. Change it when members must agree to new Terms. */
export const TERMS_VERSION = '2026-10-24.2'; // the date, plus a revision for a second change that day

/** Whether a member has agreed to the current Terms. */
export const agreedToTerms = (m) => Boolean(m?.terms_at) && m.terms_version === TERMS_VERSION;

/** The short version shown before agreeing (on WhatsApp and in the app); the full Terms are on the website. */
export const TERMS_SUMMARY =
  'Books are lent and borrowed between neighbours, at their own risk. If a book is lost, damaged or ' +
  "not returned, that's between the two of you; the volunteers who run the library aren't responsible.";
