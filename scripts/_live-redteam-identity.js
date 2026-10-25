'use strict';

function canonicalIdentity(s) {
  return String(s || '').toLowerCase()
    .replace(/애플/g, 'apple').replace(/아이폰/g, 'iphone')
    .replace(/삼성/g, 'samsung').replace(/갤럭시/g, 'galaxy')
    .replace(/에어팟/g, 'airpods').replace(/버즈/g, 'buds')
    .replace(/로지텍/g, 'logitech').replace(/다이슨/g, 'dyson').replace(/소니/g, 'sony')
    .replace(/울트라/g, 'ultra').replace(/프로\s*맥스|프로맥스/g, 'pro max')
    .replace(/프로/g, 'pro').replace(/플러스/g, 'plus').replace(/[＋+]/g, ' plus ')
    .replace(/맥스/g, 'max').replace(/에어/g, 'air').replace(/세대/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function productVariant(text) {
  const s = canonicalIdentity(text);
  if (/iphone\s*17/.test(s)) return `iphone17:${/pro\s*max|max\s*pro/.test(s) ? 'promax' : /pro/.test(s) ? 'pro' : /air/.test(s) ? 'air' : 'base'}`;
  if (/galaxy\s*s\s*26/.test(s)) return `galaxys26:${/ultra/.test(s) ? 'ultra' : /plus/.test(s) ? 'plus' : 'base'}`;
  if (/airpods/.test(s) && /\b3\b/.test(s)) return `airpods3:${/pro/.test(s) ? 'pro' : 'base'}`;
  if (/airpods/.test(s) && /\b2\b/.test(s)) return `airpods2:${/pro/.test(s) ? 'pro' : 'base'}`;
  if (/airpods/.test(s) && /\b4\b/.test(s)) return 'airpods4:base';
  if (/buds\s*3/.test(s)) return `buds3:${/pro/.test(s) ? 'pro' : 'base'}`;
  if (/buds\s*2/.test(s)) return `buds2:${/pro/.test(s) ? 'pro' : 'base'}`;
  if (/mx\s*master\s*3/.test(s)) return `mxmaster3:${/3\s*s\b/.test(s) || /3s\b/.test(s) ? '3s' : '3'}`;
  if (/dyson\s*v\s*15/.test(s)) return `dysonv15:${/absolute/.test(s) ? 'absolute' : /detect/.test(s) ? 'detect' : 'base'}`;
  if (/dyson\s*v\s*12/.test(s)) return 'dysonv12:base';
  return '';
}

function identityMatch(title, expected) {
  if (!expected) return null;
  const actual = productVariant(title), wanted = productVariant(expected);
  if (actual && wanted) return actual === wanted;
  const t = canonicalIdentity(title), e = canonicalIdentity(expected);
  return !!e && (` ${t} `).includes(` ${e} `);
}

module.exports = { canonicalIdentity, productVariant, identityMatch };
