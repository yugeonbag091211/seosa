#!/usr/bin/env node
'use strict';

/*
 * 화면과 검색 스니펫이 «매일 기록한다» 고 말하지 않는다.
 *
 * ── 왜 생겼나 (2026-11-23 전수 감사, 운영 실측) ──────────────────────
 *
 * 상품 페이지의 meta description 이 이렇게 나가고 있었다.
 *
 *     「… 현재 쿠팡 18,920원(11/23 기준). SEOSA가 **매일 기록한** 가격 추이와
 *       구매 시점 판정을 확인하세요.」
 *
 * 그런데 같은 페이지의 본문은 이렇게 적는다 — 그리고 이쪽이 사실이다.
 *
 *     「가격 기록이 최대 77일 끊긴 구간이 있어 그 사이 움직임은 알 수 없다」
 *     「SEOSA가 관측한 11번의 가격 중 …」
 *
 * 사이트맵에서 뽑은 상품 12개의 실제 기록(/api/history?__route=product):
 *
 *     관측 수 / 기록 구간(일) =  95.5% · 9.2% · 7.5% · 86.8% · 8.1% · 11.9%
 *                               13.4% · 16.4% · 42.9% · 40.0% · 96.2% · 100%
 *     구간의 모든 날에 관측이 있는 상품: 1 / 12
 *     최대 공백의 중앙값: 15일
 *
 * 즉 12개 중 11개는 «매일» 이 아니다. 이 문구는 사이트맵이 광고하는 상품
 * 페이지 21,980개의 검색 스니펫에 그대로 실린다.
 *
 * ── 무엇을 고정하나 ──────────────────────────────────────────────────
 *
 * 이 저장소는 이미 같은 원칙을 지키고 있다 — api/_seo.productTitle 주석:
 * «가격비교 는 이 페이지가 실제로 판매처 2곳 이상을 비교할 때만 쓴다».
 * 수집 주기가 보장되지 않는 한 «매일» 도 같은 종류의 말이다.
 *
 * 외부 호출 0 · DB 조회 0.
 */

const fs = require('fs');
const path = require('path');
const SEO = require('../api/_seo');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); return; }
  fail++;
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`);
}

/* 보장되지 않는 수집 주기를 단정하는 말. 상품마다 실제 관측 수가 다르다. */
const CADENCE_CLAIM = /매일\s*\S{0,6}\s*(기록|수집|갱신|업데이트|확인)/;

/*
 * 주석은 보지 않는다 — 사람에게 보이는 문구만 대상이다.
 * (코드 주석은 그 자리에서 왜 그렇게 했는지를 적는 기록이라 지울 이유가 없다.)
 * 줄 수는 그대로 두고 주석 자리만 공백으로 바꾼다 — 보고하는 줄 번호가 맞아야 한다.
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, m => m.replace(/[^\n]/g, ' '));
}

console.log('\n사용자에게 나가는 문구가 수집 주기를 단정하지 않는다');
{
  const files = [
    'api/_seo.js', 'api/_seo-pages.js', 'api/_product-page.js',
    'public/index.html', 'public/radar.html', 'public/support.html'
  ];
  for (const f of files) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) { check(true, `${f}: 파일 없음(검사 생략)`); continue; }
    const src = stripComments(fs.readFileSync(full, 'utf8'));
    const hit = src.split('\n').map((line, i) => ({ i: i + 1, line }))
      .filter(x => CADENCE_CLAIM.test(x.line));
    check(hit.length === 0, `${f}: «매일 기록/수집/갱신» 문구가 없다`,
      hit.slice(0, 3).map(x => `${x.i}: ${x.line.trim().slice(0, 90)}`));
  }
}

console.log('\nmeta description 은 그대로 동작한다 (숫자는 여전히 상품마다 다르다)');
{
  const kst = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const pts = [
    { date: kst(4), price: 1500000 }, { date: kst(3), price: 1480000 },
    { date: kst(1), price: 1460000 }, { date: kst(0), price: 1429000 }
  ];
  const d = SEO.productDescription({
    title: 'LG전자 그램 16', price: 1429000, mall: '쿠팡',
    lastDate: kst(0), summary: SEO.priceSummary(pts, null)
  });
  check(/1,429,000원/.test(d), 'description 에 현재가가 남아 있다', d);
  check(d.length <= 160, 'description 은 160자 안', d.length);
  check(!CADENCE_CLAIM.test(d), 'description 이 수집 주기를 단정하지 않는다', d);
  check(/가격 추이/.test(d), 'description 이 여전히 가격 추이를 안내한다', d);

  const empty = SEO.productDescription({ title: '가격 없는 상품', price: 0, mall: '쿠팡', lastDate: '', summary: null });
  check(!/\d원/.test(empty), '가격이 없으면 금액을 쓰지 않는다(기존 계약 유지)', empty);
}

console.log(`\nSEO cadence claims: ${pass}/${pass + fail} PASS, ${fail} FAIL. External calls: 0. DB queries: 0.`);
process.exit(fail ? 1 : 0);
