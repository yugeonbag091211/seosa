'use strict';
/*
 * 동결 카탈로그 위의 «공급원 대역» — BM25 어휘 검색으로 질문마다 후보 30개를 고른다.
 *
 * 왜 필요한가: 쿠팡·ADPICK 실호출 없이(호출 한도·저장 오염 없이) 수백 문항을 같은 후보로
 * 반복 비교하려면, 공급원처럼 «검색어 토큰이 걸린 상품» 을 돌려주는 고정된 검색기가 필요하다.
 * 실제 공급원보다 어렵다: 공급원의 자체 순위가 이미 걸러 주는 부속·다른 모델이 그대로 섞인다.
 *
 * ★ 검사 대상 코드(api/_product-gate.js)를 쓰지 않는다. 토큰화만 단순 규칙으로 한다.
 */
const fs = require('fs');

const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
function tokens(s) {
  const out = [];
  norm(s).split(' ').forEach(chunk => {
    if (!chunk) return;
    (chunk.match(/[가-힣]+|[0-9a-z]+/g) || []).forEach(p => { if (p.length >= 1) out.push(p); });
  });
  return out;
}
// 공급원에 보내기 전 사용자가 붙인 가격·요청·상태 말은 뺀다 (검색어 자체만 보낸다).
const NOISE = /(?:\d[\d,.]*\s*(?:억|천|백)?\s*만?\s*원\s*(?:대|이하|이상|미만|초과|까지|이내|짜리|정도)?|\d[\d,.]*\s*만\s*(?:원)?\s*(?:대|이하|이상|미만|까지|이내)?|중고\s*말고|리퍼\s*말고|새\s*(?:상품|제품)|새제품|말고|빼고|제외|추천해줘|보여줘|찾아줘)/g;

class CatalogRetriever {
  constructor(snapshotPath) {
    const text = fs.readFileSync(snapshotPath, 'utf8');
    this.rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (!r.title || !(Number(r.lprice) > 0)) continue;
      this.rows.push(r);
    }
    this.index = new Map();
    this.len = new Float64Array(this.rows.length);
    let total = 0;
    this.rows.forEach((r, i) => {
      const toks = tokens(r.title);
      this.len[i] = toks.length;
      total += toks.length;
      const seen = new Set();
      toks.forEach(t => {
        if (seen.has(t)) return;
        seen.add(t);
        let list = this.index.get(t);
        if (!list) { list = []; this.index.set(t, list); }
        list.push(i);
      });
      r._flat = toks.join('');
    });
    this.avgLen = total / Math.max(1, this.rows.length);
  }

  search(query, limit = 30) {
    const q = String(query || '').replace(NOISE, ' ');
    const qt = [...new Set(tokens(q))].filter(t => t.length >= 2 || /\d/.test(t));
    const N = this.rows.length, k1 = 1.2, b = 0.75;
    const scores = new Map();
    for (const t of qt) {
      // 붙여 쓴 상품명("아이폰16프로")도 찾도록 정확 토큰 + 그 토큰을 품은 2자 이상 토큰 후보를 함께 본다.
      const posting = this.index.get(t) || [];
      const df = posting.length;
      if (!df) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const i of posting) {
        const tf = 1;
        const s = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * this.len[i] / this.avgLen));
        scores.set(i, (scores.get(i) || 0) + s);
      }
    }
    // 띄어쓰기 차이: 질의 토큰이 붙은 채로 상품명 안에 있으면 약하게 더한다.
    const fused = qt.filter(t => t.length >= 3);
    if (fused.length) {
      for (const [i] of scores) {
        const flat = this.rows[i]._flat;
        fused.forEach(t => { if (flat.includes(t)) scores.set(i, scores.get(i) + 0.05); });
      }
    }
    return [...scores.entries()]
      .sort((a, b2) => b2[1] - a[1] || String(this.rows[a[0]].product_id).localeCompare(String(this.rows[b2[0]].product_id)))
      .slice(0, limit)
      .map(([i]) => this.toItem(this.rows[i]));
  }

  toItem(r) {
    return {
      title: r.title, lprice: Number(r.lprice), productId: String(r.product_id), mall: r.mall,
      mallLabel: r.mall === 'ADPICK' ? 'ADPICK' : '', vendorItemId: r.vendor_item_id || '',
      link: `https://example.invalid/${encodeURIComponent(String(r.product_id))}`, isCoupang: r.mall === '쿠팡',
      oprice: Number(r.lprice), savePct: 0, _source: 'api'
    };
  }
}

module.exports = { CatalogRetriever, tokens };
