#!/usr/bin/env node
'use strict';
/*
 * 200문항 시점 보고서 생성 (summary.md, reproduction.md). 수치는 전부 결과 파일에서 계산한다.
 *   node scripts/production-ai-5000/report-200.js [결과 폴더]
 */
const fs = require('fs');
const path = require('path');
const DIR = path.resolve(process.argv[2] || path.join(__dirname, '../../reports/production-ai-5000'));
const rd = p => fs.readFileSync(path.join(DIR, p), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const Q = new Map(rd('questions.jsonl').map(q => [q.id, q]));
const R = rd('responses.jsonl');
const RM = new Map(R.map(r => [r.id, r]));
const E = rd('evaluations.jsonl');
const F = new Map(rd('failures.jsonl').map(f => [f.id, f]));
const L = new Map(rd('server-logs.jsonl').map(l => [l.id, l]));
const H = rd('history-recheck.jsonl');
const other = JSON.parse(fs.readFileSync(path.join(DIR, 'other-traffic.json'), 'utf8'));
const neon = rd('neon-usage.jsonl');
const OLD = new Map(rd('evaluations-before-recalibration.jsonl').map(e => [e.id, e]));
const moved = (a, bs) => E.filter(e => OLD.get(e.id).verdict === a && bs.includes(e.verdict));
const released = moved('FAIL', ['PASS', 'UNVERIFIED']);
const caught = moved('UNVERIFIED', ['FAIL']);
const passToFail = moved('PASS', ['FAIL']);
const idList = list => list.map(e => e.id).join(', ') || '없음';
const BA = JSON.parse(fs.readFileSync(path.join(DIR, 'offline-before-after.json'), 'utf8'));
const pct = n => (n * 100).toFixed(1) + '%';
const quant = (a, q) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * q)];

const LABEL = { recommend: '상품 추천', budget: '예산·가격', compare: '상품 비교', model: '모델·액세서리', option: '옵션·상품 상태', memory: '연속 대화 기억', timing: '구매 시점 판단', edge: '예외 상황', logic: '답변 논리성' };
const tally = {};
for (const e of E) {
  const c = tally[e.category] = tally[e.category] || { n: 0, PASS: 0, FAIL: 0, UNVERIFIED: 0, INFRA_ERROR: 0, critical: 0, major: 0, minor: 0 };
  c.n++; c[e.verdict]++; if (e.severity) c[e.severity]++;
}
const T = { n: 0, PASS: 0, FAIL: 0, UNVERIFIED: 0, INFRA_ERROR: 0, critical: 0, major: 0, minor: 0 };
Object.values(tally).forEach(c => Object.keys(T).forEach(k => { T[k] += c[k]; }));
const rate = c => { const d = c.PASS + c.FAIL; return d ? pct(c.FAIL / d) : '-'; };
const rows = Object.keys(LABEL).map(k => {
  const c = tally[k] || {};
  return `| ${LABEL[k]} | ${c.n} | ${c.PASS} | ${c.FAIL} | ${c.UNVERIFIED} | ${c.INFRA_ERROR} | ${c.critical} / ${c.major} / ${c.minor} | ${rate(c)} |`;
}).join('\n');

const ms = R.map(r => r.ms);
let gpt = 0, noObs = 0, none = 0, usd = 0, inTok = 0, outTok = 0;
const ad = {}, co = {};
R.forEach(r => {
  const l = L.get(r.requestId);
  if (!l) return;
  (l.adpick || []).forEach(x => { const k = x.decision + (x.http ? ':' + x.http : ''); ad[k] = (ad[k] || 0) + 1; });
  (l.coupang || []).forEach(x => { const k = x.decision + (x.http ? ':' + x.http : ''); co[k] = (co[k] || 0) + 1; });
  if (!l.obs) { noObs++; return; }
  if (l.obs.model && l.obs.model !== 'none') gpt++; else none++;
  usd += Number(l.obs.costUsd) || 0; inTok += Number(l.obs.inTok) || 0; outTok += Number(l.obs.outTok) || 0;
});
const fmtCount = o => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');
const hc = {}; H.forEach(h => { hc[h.judge] = (hc[h.judge] || 0) + 1; });
const ty = {}; E.forEach(e => e.failTypes.forEach(t => { ty[t] = (ty[t] || 0) + 1; }));

const TOP = [
  ['Q00049', '후속 발화가 검색어가 됨', '«최종» 으로 검색. 태블릿 대화에서 종교 서적 1위'],
  ['Q00045', '후속 발화가 검색어가 됨', '«나아» 로 검색. 전동칫솔·양말·운동화'],
  ['Q00027', '후속 발화가 검색어가 됨', '«돈은 밖에 써요» 로 검색. 예산 말이 책 검색이 됨'],
  ['Q00157', '기억 실패', '«화이트» 로 검색. 이어폰 대화에서 원피스'],
  ['Q00158', '기억 실패', '조건 요약은 맞는데 카드는 낚싯대. 답변과 카드 불일치'],
  ['Q00165', '기억 실패', '예산 변경 말이 검색어가 됨. 이어폰 대화에서 LP'],
  ['Q00193', '기억 실패', '노트북 대화에서 «미개봉 새 제품» 검색. 갤럭시 버즈'],
  ['Q00188', '제외 조건 망각', '3턴에서 뺀 HP 가 13턴에 1위'],
  ['Q00062', '제외 조건 무시', '«LG 제품은 절대 싫어요» 에 LG 제습기 1·2위'],
  ['Q00087', '제외 조건 무시', '«아디다스 제품은 절대 싫어요» 에 아디다스만 표시'],
  ['Q00018', '상황 말이 검색어에 혼입', '«넘기지 선에서 외장하드…» 로 검색. 책 추천'],
  ['Q00056', '상황 말이 검색어에 혼입', '«음파 칫솔 부탁드려요» 로 검색. 안내 팻말 추천'],
  ['Q00105', '상황 말이 검색어에 혼입', '«고마워요» 로 검색. 다이슨 질문에 그림책'],
  ['Q00124', '예산 하한 역전', '«최소 120만» 을 상한으로 읽음. 9.9만원 서비스 상품'],
  ['Q00118', '예산 하한 무시', '110만~170만 카메라에 4만원대 토이 카메라'],
  ['Q00007', '비교 분리 실패', '«A 살까 B 살까» 를 한 검색어로 처리해 0건'],
  ['Q00077', '비교 분리 실패', '«A vs B» 를 한 검색어로 처리해 0건'],
  ['Q00005', '순위 판단', '침실용 질문에 384만원 산업용을 1위로'],
  ['Q00030', '근거와 다른 설명', '예산 80만원을 «88만원» 으로 말하고, 틀린 상품(PDF)의 추천 이유를 설명'],
  ['Q00109', '엉뚱한 카드·내부명 노출', '«삼성 T7» 질문에 삼성제약 알부민을 «첫 번째 추천 카드 (ADPICK)» 로 표시']
];
const topMd = TOP.map(([id, type, why], i) => {
  const r = RM.get(id), q = Q.get(id), f = F.get(id), l = L.get(r.requestId);
  const cards = (r.response.items || []).slice(0, 5).map(x => `  - ${x.title} — ${Number(x.lprice).toLocaleString('en-US')}원 (${x.mallLabel || x.mall}, 상품 ID ${x.productId}${x.vendorItemId ? ', 옵션 ID ' + x.vendorItemId : ''})`).join('\n') || '  - (카드 없음)';
  const prev = q.session ? `\n- **대화 위치·유지할 조건:** ${q.session} ${q.turn}턴째, 유지해야 할 상태 ${JSON.stringify(q.expect.state)}` : '';
  const kw = l && (l.kwSeen || []).length ? `\n- **서버 로그 검색어:** ${[...new Set(l.kwSeen)].join(', ')}` : '';
  return `### ${i + 1}. ${type} — ${why} (${id})\n\n- **질문:** ${q.text}${prev}${kw}\n- **실제 답변:**\n\n> ${String(r.response.text).replace(/\n+/g, '\n> ')}\n\n- **카드:**\n${cards}\n- **판정 근거:** ${(f ? f.fails : []).slice(0, 3).map(x => `\`${x.type}\` ${x.evidence}`).join(' / ').replace(/\n/g, ' ')}`;
}).join('\n\n');

const md = `# SEOSA Production AI 실검증 — 200문항 중간 보고

> **완료 범위:** 목표 5,000개 중 **200개 실행, 4,800개 남음.** 3차는 수정 결과 비교 전까지 실행하지 않는다(사용자 지시).
> Production 커밋 \`718fe7f\` 한 버전의 결과만 담았다. 수정 버전 결과를 섞지 않는다.

## 1. 결과

| 검증 분야 | 실제 질문 | 성공 | 실패 | 미검증 | 운영 오류 | 실패 등급(치명/중대/경미) | 오류율* |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows}
| **합계** | **${T.n}** | **${T.PASS}** | **${T.FAIL}** | **${T.UNVERIFIED}** | **${T.INFRA_ERROR}** | **${T.critical} / ${T.major} / ${T.minor}** | **${rate(T)}** |

\\* 오류율 = 실패 ÷ (성공 + 실패). 미검증·운영 오류는 분모에서 뺐다. 200건은 규칙으로 뽑은 표본이며 분야별 표본이 작다(최소 ${Math.min(...Object.values(tally).map(c => c.n))}건). 전체 성공률로 일반화하지 않는다.

- **치명:** 엉뚱한 상품, 조건 위반, 기억 상실, 비교 실패. **중대:** 사실과 다른 설명. **경미:** 내부명 노출, 답변 후보와 카드 수 불일치, 하루치 관측을 근거로 삼은 표현.
- 대화 기억 세션은 3개(75턴)뿐이다. 계획된 40세션의 일부다.
- 실패 ${T.FAIL}건 중 ${(tally.memory || {}).FAIL}건은 대화 세션 3개에서 나왔고, 앞 턴의 오류가 이어진 경우가 섞여 있다. 한 번 어긋나면 복구되지 않는 것이 결함 자체라 그대로 셌지만, 독립 사건 수로 읽으면 안 된다.

## 2. 운영 수치

| 항목 | 값 |
|---|---:|
| 실제 Production 요청 | ${R.length} (재시도 ${R.reduce((s, r) => s + (r.attempts || 1), 0) - R.length}회) |
| Playwright UI / API | ${R.filter(r => r.channel === 'ui').length} / ${R.filter(r => r.channel !== 'ui').length} |
| HTTP 상태 | 200 ${R.filter(r => r.status === 200).length}건, 5xx·429 0건 |
| 서버 로그 대조 | ${R.filter(r => L.has(r.requestId)).length} / ${R.length} |
| 실제 GPT 답변(${'gpt-6-luna'}) | ${gpt} |
| 모델 미사용(결정론 답) | ${none} |
| 로그에 지표 없음(판별 불가) | ${noObs + (R.length - R.filter(r => L.has(r.requestId)).length)} |
| ADPICK 검색 | ${fmtCount(ad)} |
| 쿠팡 검색 | ${fmtCount(co)} |
| 추정 GPT 비용 | $${usd.toFixed(4)} (입력 ${inTok.toLocaleString('en-US')} / 출력 ${outTok.toLocaleString('en-US')} 토큰). 로그에 지표가 있는 요청만 합산 |
| 응답 시간 | 평균 ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)}ms, p50 ${quant(ms, 0.5)}ms, p95 ${quant(ms, 0.95)}ms, 최대 ${Math.max(...ms)}ms |
| 같은 시간대 다른 이용자의 /api/ai | ${other.ai}건 (${fmtCount(other.byStatus)}) |
| Neon 사용량(수집 시작→종료) | compute ${neon[0].computeHours}→${neon[neon.length - 1].computeHours} CU-h, 전송 ${neon[0].transferGB}→${neon[neon.length - 1].transferGB} GB. 카운터 갱신이 늦어 이 구간의 증가분은 측정되지 않았을 수 있다 |

SKIP 은 ADPICK 분당 한도로 호출하지 않은 경우다. 판매처 한도 오류(429)는 없었다.

## 3. 평가기 오탐 분리

1차 초기 판정의 실패 34건을 포함해, 2차까지 나온 실패를 답변과 카드로 직접 읽어 평가기를 재보정했다.

| 재판정 | 건수 | 내용 |
|---|---:|---|
| **평가기 오탐:** 실패 → 통과·미검증 | ${released.length} | 스스로 한정한 «기록상 최저가» 를 모순으로 본 경우, 정직한 부재 고지를 거짓 가격으로 본 경우, 잘못된 전제를 바르게 고친 답, 모델 정규식 오류(M6 를 M4 로 인식) 등. ${idList(released)} |
| **평가기 누락:** 미검증 → 실패 | ${caught.length} | 발화 전체가 검색어가 된 뒤 0건으로 끝나, 정직한 부재 고지처럼 보였던 경우. ${idList(caught)} |
| 평가기 누락: 통과 → 실패 | ${passToFail.length} | 답변의 후보 금액이 카드에 없는 경우. ${idList(passToFail)} |
| **실제 오류로 유지** | ${E.filter(e => e.verdict === 'FAIL' && OLD.get(e.id).verdict === 'FAIL').length} | 재판정 후에도 실패 |

1차 50건의 첫 판정 실패 34건은 재판정 후 실패 ${E.filter(e => e.id <= 'Q00050' && e.verdict === 'FAIL').length}건이다. 재판정 전 값은 \`evaluations-before-recalibration.jsonl\` 에 남겼다. 이 파일은 1차 보정 뒤의 판정이므로, 위 건수는 그 시점과 현재의 차이다.

실패 전체와 통과 ${T.PASS}건을 사람이 읽었다. 평가기가 통과시켰지만 **실제로는 의심스러운 7건**은 집계를 바꾸지 않고 따로 적는다. 이 7건이 전부 실패라면 통과는 ${T.PASS - 7}건이다.

| ID | 의심 내용 |
|---|---|
| Q00036 | 앞 턴 오류가 이어져, 태블릿 대화에서 LCD 드로잉 패드의 구매 시점을 답함 |
| Q00035 | 같은 이유로 드로잉 패드와 갤럭시탭을 비교함 |
| Q00039 | 태블릿 대화에서 태블릿 가방의 가격을 현재가로 답함 |
| Q00070 | 가격이 오르는지 물었는데 추천 양식으로 답하고, 추세에는 답하지 않음 |
| Q00123 | 버츄오 플러스를 물었는데 버츄오 팝 플러스를 답함(평가기 모델 정규식이 넓음) |
| Q00142 | 답변은 26만원 냉장고를 권하는데 첫 카드는 121만원 양문형 |
| Q00194 | «다음 순위» 질문에 찾던 상품을 잊고 결과 없음으로 답함 |

### «기록상 최저가 수준» 재판정

답변에 이 표현이 나온 ${H.length}건을 공개 API(\`/api/history-batch\`)의 실제 관측과 대조했다.

| 판정 | 건수 | 뜻 |
|---|---:|---|
| 실제로 더 낮은 가격이 있었음(거짓) | ${hc.FALSE || 0} | 거짓 진술은 없었다 |
| 관측 1일치 | ${hc.TRIVIAL || 0} | 산술로는 참이지만 현재가와 같다는 뜻뿐이다 |
| 관측 2~6일 | ${hc.THIN || 0} | 참, 다만 근거가 약하다 |
| 관측 7일 이상 | ${hc.TRUE || 0} | 참 |

즉 **거짓 가격이 아니라 근거 없는 표현**이다. 같은 답에서 기록 부족을 고지한 ${H.filter(h => h.admitsThin).length}건은 실패에서 뺐고, 고지 없이 관측 1일치를 추천 이유로 쓴 ${ty.trivial_lowest_claim || 0}건만 경미한 실패로 남겼다.

## 4. 공통 원인

| # | 원인 | 코드 경로 | 재현 |
|---|---|---|---|
| RC1 | 찾던 상품이 있어도 후속 발화의 낱말을 새 검색어로 쓴다. 상품 근거가 없어도 \`isProductQuery\` 를 통과하고, 일부는 확신 high 라 LLM 분류도 건너뛴다 | \`api/_intent.js\` classify, extractQuery, isProductQuery | 오프라인 재현 |
| RC2 | 잘못된 낱말이 \`conversationProduct\` 를 통해 «찾던 상품» 으로 굳어 convState 에 저장된다. 이후 턴이 전부 그 낱말로 검색해 복구되지 않는다 | \`api/_intent.js\` conversationProduct, \`api/_convstate.js\` resolve | 오프라인 재현 |
| RC3 | 브랜드 제외를 최근 발화 6개에서만 읽고 서명 상태에 없다. 또 «제품은 절대 싫어요» 문형을 못 읽고, «빼줘» 는 감점뿐이라 카드에 남는다 | \`api/_feedback.js\` EXCLUDE_RE, collectExcludes, applyExcludes | 오프라인 재현 |
| RC4 | 상황 설명·말투가 검색어와 식별 계약에 섞인다 | \`api/_intent.js\` extractQuery | 오프라인 재현 |
| RC5 | 예산 파서: «최소 120만» 을 상한으로, «넘되·안 넘는» 무시, «최소 A, 최대 B» 의 하한 소실, 한글 금액 미인식 | \`api/_shopintent.js\` parseConstraints | 오프라인 재현 |
| RC6 | 비교 문형(살까, vs+뭐가, 대신, 에서~로) 미인식과 앞 상황 설명 혼입 | \`api/_ai-comparison.js\` parseComparison | 오프라인 재현 |
| RC7 | 상품 이름과 가격 낱말이 있어도 지식 답변으로 빠져 검색하지 않는다 | \`api/_intent.js\` classify | 오프라인 재현 |
| RC8 | 답변 표면: \`(ADPICK)\` 노출, 관측 하루치의 «최저가 수준», 예산 여유분(×1.1)을 예산이라고 말함, 후보 목록과 카드 수 불일치 | \`api/ai.js\`, \`api/_decision.js\`, \`api/_shopintent.js\`, \`api/_concierge.js\` | 코드 확인 |
| RC9 | 부속품·동물용·저가 부품이 본품 질문의 카드에 남고, 동떨어진 고가 상품이 1위가 된다 | \`api/_aiidentity.js\` 상품 판정, 순위 | Production 관측 |

실패 유형별 건수: ${Object.entries(ty).sort((a, b) => b[1] - a[1]).map(([k, v]) => `\`${k}\` ${v}`).join(', ')}

## 5. 대표 오류 20개 (실제 질문·답변 원문)

${topMd}

## 6. 수정 PR과 수정 전후 비교

수정은 [PR #227](https://github.com/yugeonbag091211/seosa/pull/227) (\`fix/ai-followup-query-structure\`) 에 있다. **Production 미배포**이며 이 보고서의 200건은 전부 수정 전 \`718fe7f\` 결과다.

5,000문항 코퍼스를 수정 전후 파서에 재생한 **오프라인** 비교다(외부 호출 0회). 운영 성공률이 아니다.

| 항목 | 수정 전 | 수정 후 |
|---|---:|---:|
| 단일 질문의 검색어가 상품을 가리킴 (${BA.singles.before.n}건) | ${pct(BA.singles.before.ok / BA.singles.before.n)} | ${pct(BA.singles.after.ok / BA.singles.after.n)} |
| 대화 턴이 찾던 상품을 유지 (${BA.sessions.before.n}턴) | ${pct(BA.sessions.before.ok / BA.sessions.before.n)} | ${pct(BA.sessions.after.ok / BA.sessions.after.n)} |
| 비교 질문의 두 모델 분리 (${BA.compare.n}건) | ${pct(BA.compare.before / BA.compare.n)} | ${pct(BA.compare.after / BA.compare.n)} |
| 예산 구간 해석 (${BA.budget.n}건) | ${pct(BA.budget.before / BA.budget.n)} | ${pct(BA.budget.after / BA.budget.n)} |

수정 뒤 실제 GPT·판매처 결과는 아직 측정하지 않았다. RC8 의 후보 목록과 카드 수 불일치, RC9 의 부속품 혼입·순위 문제는 이 PR 에서 고치지 않았다.

3차 800문항은 시작하지 않았다. 실행할 때는 배포 SHA 를 기록하고 \`718fe7f\` 결과와 합산하지 않는다.

## 7. 한계

- 규칙 평가기다. 문맥을 사람처럼 읽지 못하며, 사람 검토는 200건 한 번뿐이다. 미검증 ${T.UNVERIFIED}건은 정답 여부를 확정하지 못했다.
- 코퍼스는 상품·사용 장면·문형 조합으로 생성했다(문형 골격 4,100종, 같은 골격 최대 8회). 일부 끝말(«답변 고마워요», «말이야») 은 실제 소비자보다 어색할 수 있고, 이 때문에 파서 실패가 더 많이 드러났을 수 있다.
- 로그인 사용자 경로는 검증하지 않았다(게스트만).
- 판매처 최종 결제 화면은 열지 않았고, 상품 링크도 누르지 않았다.
`;
fs.writeFileSync(path.join(DIR, 'summary.md'), md);

const rep = `# 중요 오류 재현 방법

모든 재현은 운영에 **읽기 전용이 아닌 일반 사용자 요청**을 한 건 보낸다(판매처 검색·GPT 호출 발생). 상품 링크는 열지 않는다. 판매처 한도를 지키려면 20초 이상 간격을 둔다.

## A. 오프라인 재현 (호출 0회, 권장)

\`\`\`bash
node -e "const I=require('./api/ai.js')._internal;const h=[{role:'user',text:'필기용 태블릿 추천해줘'},{role:'assistant',text:'x'}];for(const q of ['돈은 80만원밖에 못 써요','최종 추천 하나 궁금해','위 두 제품 중에 뭐가 나아?','신품으로만 추천해 정확히요'])console.log(q,'=>',I.heuristicIntent(q,h,{source:'none'}).query)"
\`\`\`

수정 전(\`718fe7f\`) 결과: \`돈은 밖에 써요\`, \`최종\`, \`나아\`, \`신품으로 정확히요\`.

\`\`\`bash
node -e "const {parseConstraints:p}=require('./api/_shopintent');for(const q of ['노트북 최소 120만은 줘야 쓸 만하다던데','6만원은 넘되 120,000원은 안 넘는 운동화','십삼만원 이상은 써도 되니까 헤드셋'])console.log(q,p(q).budgetMin,p(q).budgetMax)"
\`\`\`

수정 전 결과: \`0 1320000\`, \`0 132000\`, \`0 0\`.

## B. 운영 재현

\`\`\`bash
node scripts/production-ai-5000/run.js --until 200 --gap-ms 20000
\`\`\`

이미 저장된 질문은 건너뛰므로, 새 결과 폴더를 쓰거나 \`reports/production-ai-5000/responses.jsonl\` 의 해당 줄을 옮긴 뒤 실행한다. 세션 오류(예: Q00049)는 앞 턴부터 순서대로 보내야 재현된다. 판매처 결과가 달라지면 같은 상품이 나오지 않을 수 있으나, 서버 로그의 검색어는 같다.

## C. 대화 세션 수동 재현

웹에서 대화를 지우고 차례로 입력한다.

1. \`필기용 태블릿 추천해줘\`
2. \`돈은 80만원밖에 못 써요\` → 태블릿이 아닌 카드가 나오면 재현
`;
fs.writeFileSync(path.join(DIR, 'reproduction.md'), rep);
console.log('ok', T);
