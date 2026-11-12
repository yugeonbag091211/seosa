'use strict';
// CI-size question set over tools/ai-eval/fixtures/catalog-fixture.jsonl
// (26 synthetic rows). It exercises the Promptfoo wiring and the judges in
// GitHub Actions without the real catalog snapshot. NOT a quality measurement.
const P = (query, category, extra = {}) => ({ mode: 'recommend', query, compareQuery: '', category, maxPrice: null,
  exclusions: [], mallOnly: '', exactModel: '', ...extra });
const questions = [
  { id: 'X001', type: 'model', cat: '마우스', turns: [{ p: '로지텍 G304 무선 마우스 찾아줘', plan: P('로지텍 G304 무선 마우스', '마우스', { exactModel: 'G304' }),
    spec: { all: [['로지텍', 'logitech'], ['g304']], floor: 8000 }, expect: 'AUTO' }] },
  { id: 'X002', type: 'budget', cat: '노트북', turns: [{ p: '50만원 이하 가벼운 노트북 추천', plan: P('가벼운 노트북', '노트북', { maxPrice: 500000 }),
    spec: { all: [['노트북', '랩탑', 'laptop']], not: ['가방', '케이블'], max: 500000, floor: 150000 }, expect: 'AUTO' }] },
  { id: 'X003', type: 'model', cat: '이어폰', turns: [{ p: '갤럭시 버즈3 프로 가격', plan: P('갤럭시 버즈3 프로', '이어폰', { exactModel: '버즈3 프로' }),
    spec: { all: [['버즈3프로', 'buds3pro']], floor: 100000 }, expect: 'AUTO' }] },
  { id: 'X004', type: 'model', cat: '스마트폰', turns: [{ p: '갤럭시 S25 울트라 가격 알려줘', plan: P('갤럭시 S25 울트라', '스마트폰'),
    spec: { all: [['s25울트라', 's25ultra']], notRe: ['기기\\s*변경|공통\\s*지원|완납'], floor: 700000 }, expect: 'AUTO' }] },
  { id: 'X005', type: 'followup', cat: '외장하드', turns: [
    { p: '외장 SSD 1TB 추천', plan: P('외장 SSD 1TB', '외장하드'), spec: { all: [['ssd'], ['1tb']], floor: 40000 }, expect: 'AUTO' },
    { p: '삼성 제품은 제외해줘', plan: P('외장 SSD 1TB', '외장하드', { exclusions: ['삼성'] }), spec: { all: [['ssd'], ['1tb']], not: ['삼성'], floor: 40000 }, expect: 'AUTO' }] },
  { id: 'X006', type: 'absent', cat: '헤드폰', turns: [{ p: '소니 WH-1000XM6 가격', plan: P('소니 WH-1000XM6', '헤드폰', { exactModel: 'WH-1000XM6' }),
    spec: { all: [['wh1000xm6']], floor: 200000 }, expect: 'AUTO' }] },
  { id: 'X007', type: 'outage', cat: '마우스', fault: { db: 'error' }, turns: [{ p: '무선 마우스 추천', plan: P('무선 마우스', '마우스'),
    spec: { all: [['마우스'], ['무선']], floor: 5000 }, expect: 'OUTAGE' }] },
  { id: 'X008', type: 'brand', cat: '공기청정기', turns: [{ p: '위닉스 공기청정기 추천해줘', plan: P('위닉스 공기청정기', '공기청정기'),
    spec: { all: [['위닉스'], ['공기청정기']], notRe: ['청정기\\s*/\\s*가습기'], floor: 50000 }, expect: 'AUTO' }] }
];
const meta = { set: 'ai-v34-ci-fixture', written: '2026-11-12', asOf: '2026-11-06T05:16:02.218Z', priceAgeLimitDays: 10,
  corpus: 'tools/ai-eval/fixtures/catalog-fixture.jsonl (synthetic)' };
module.exports = { meta, questions };
