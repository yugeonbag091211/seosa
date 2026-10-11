/*
 * Display text cleanup (from the PR #34 prototype). Pure, so node tests can load it.
 */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  times: '×', trade: '™', reg: '®', copy: '©',
};

/**
 * Some product names arrive with HTML entities from the shopping providers (`&amp;`, `&#39;`).
 * Decodes exactly one level, once, at the API boundary. Unknown entities and bare `&` stay as they are.
 */
export function decodeHtmlEntities(value: string): string {
  if (!value || value.indexOf('&') === -1) return value;
  return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const valid = Number.isInteger(code) && code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF);
      return valid ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : match;
  });
}
