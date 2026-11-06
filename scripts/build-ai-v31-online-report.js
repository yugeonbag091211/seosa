'use strict';
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'docs'),logs=path.join(root,'reports/ai-v3-online-20261105');
const read=p=>fs.readFileSync(p,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const older=read(path.join(dir,'ai-v3-online-evaluation-2026-11-05-results.jsonl')).filter(x=>/^Q\d{3}$/.test(x.id));
const current=read(path.join(logs,'full.jsonl'));
const summary=JSON.parse(fs.readFileSync(path.join(logs,'full-summary.json'),'utf8'));
if(older.length!==100||current.length!==100||summary.ran!==100||new Set(current.map(x=>x.question)).size!==100)
  throw Error('Only full 100-question live comparisons allowed');
const score=(list,key)=>list.reduce((a,x)=>(a[x[key]]++,a),{PASS:0,FAIL:0,UNVERIFIED:0});
const clean=s=>String(s||'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ').slice(0,170);
function verify(r){
 const problems=new Set(r.errors||[]);
 for(const c of r.cards||[]){
  const t=String(c.title||'');
  if(/(?:태블릿|갤럭시탭|아이패드)/i.test(r.question)&&
    /(?:micro\s*sd|sdxc|메모리\s*카드|TF\s*카드)/i.test(t)&&/(?:카드|card|sdxc)/i.test(t))
    problems.add('tablet_memory_card');
  if(/외장\s*(?:ssd|하드)|외장하드/i.test(r.question)&&
    /^(?:USB\s+[AC]\s+to\s+[AC]\s+케이블|케이블|cable)/i.test(t))
    problems.add('ssd_cable_accessory');
  if(/(?:아이폰|스마트폰|갤럭시\s*S\d+)/i.test(r.question)&&
    /(?:공통지원금|통신사이동|번호이동|선택약정|완납개통|할부원금)/i.test(t))
    problems.add('conditional_carrier_price');
  if(/(?:아이패드|ipad)/i.test(t)&&/(?:안드로이드|android)\s*\d/i.test(t))
    problems.add('contradictory_product_claim');
 }
 return {reviewed:problems.size?'FAIL':r.verdict,reasons:[...problems]};
}
const rows=current.map(r=>{
 const v=verify(r);
 return {id:r.id,question:r.question,automatic:r.verdict,...v,
  http:r.http,apiStatus:r.apiStatus,elapsedMs:r.elapsedMs,
  cards:r.cards.map(c=>({title:c.title,price:c.price,condition:c.condition})),
  state:r.state,stats:r.stats};
});
const baseline=score(older,'reviewed'),auto=score(rows,'automatic'),reviewed=score(rows,'reviewed');
const failed=rows.filter(x=>x.reviewed==='FAIL'),unverified=rows.filter(x=>x.reviewed==='UNVERIFIED');
const prefix='ai-v31-online-evaluation-2026-11-06';
const md=[
'# SEOSA AI v3.1 — 온라인 100문항 검증 보고서',
'',
'- 날짜: 2026-11-06 (KST)',
'- 검증 브랜치: feat/ai-v31-engine-20261106',
'- 검증 커밋: 509027673dcc7eb1070111e95dd84cae13c71c68',
'- Vercel Preview: https://seosa-f5q64wvy9-seosa.vercel.app (접근 보호)',
'- Neon: migration-test-20261020 / seosa_v3_reader, 읽기 전용',
'- Production 미변경',
'- 실제 GPT와 상품 DB에 서로 다른 질문 100개를 전송',
'',
'## 결과',
'',
'| 기준 | v3 기존 100문항 | v3.1 최신 100문항 |',
'|---|---:|---:|',
'| 자동 PASS | 74 | '+auto.PASS+' |',
'| 자동 FAIL | 2 | '+auto.FAIL+' |',
'| 자동 미검증 | 24 | '+auto.UNVERIFIED+' |',
'| 재검토 PASS | '+baseline.PASS+' | '+reviewed.PASS+' |',
'| 재검토 FAIL | '+baseline.FAIL+' | '+reviewed.FAIL+' |',
'| 재검토 미검증 | '+baseline.UNVERIFIED+' | '+reviewed.UNVERIFIED+' |',
'',
'재검토 수치는 코드 검사와 상품 제목 기반의 명백한 모순·부품·요금제 조건 검사 결과다. 판매처 최종 가격, 진품 여부, 배송비, 실제 재고를 모두 검증한 최종 구매 정확도는 아니다.',
'같은 100문항을 사용했지만 GPT 출력은 비결정적이고 DB가 갱신되므로 관측치의 직접 비교는 주의가 필요하다.',
'',
'## 실제 사용량',
'',
'| 지표 | 값 |',
'|---|---:|',
'| GPT 호출 | '+summary.tokens.calls+' |',
'| 입력 토큰 | '+summary.tokens.input+' |',
'| 출력 토큰 | '+summary.tokens.output+' |',
'| 소요 초 | '+summary.elapsedSeconds+' |',
'',
'모델 gpt-4.1-mini. 과금내역은 별도 확인 전이므로 달러 비용은 확정하지 않는다.',
'',
'## 확정 FAIL',
'',
'| ID | 질문 | 사유 |',
'|---|---|---|',
...failed.map(r=>'| '+r.id+' | '+clean(r.question)+' | '+clean(r.reasons.join(', ')||'자동 판정 FAIL')+' |'),
'',
'## 미검증',
'',
'| ID | 질문 | 보류 사유 |',
'|---|---|---|',
...unverified.map(r=>'| '+r.id+' | '+clean(r.question)+' | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |'),
'',
'## 전체 100문항 결과',
'',
'| ID | 질문 | 자동 | 재검토 | 상품 수 | 비고 |',
'|---|---|---|---|---:|---|',
...rows.map(r=>'| '+r.id+' | '+clean(r.question)+' | '+r.automatic+' | '+r.reviewed+' | '+r.cards.length+' | '+clean(r.reasons.join(', '))+' |'),
'',
'## 남은 검증 과제',
'',
'- 미검증 결과는 DB 상품·옵션·수집 품질을 읽기 전용으로 대조.',
'- 상품 옵션 가격·통신사 약정·배송비·정품 인증은 별도 데이터 출처 검증.',
'- 반복 사용한 100문항과 독립적인 새로운 홀드아웃 테스트 필요.',
'- 속도·API 토큰·Neon DB 쿼리량 회귀 확인.',
'- Production 반영 전 별도 승인, 기존 Production 변경 금지.',
'',
'## 아티팩트',
'',
'- '+prefix+'-results.jsonl: 질문별 카드명, 기록 가격, 서버 상태, 모델 사용량. 외부 클릭 URL/인증 토큰 제외.',
'- '+prefix+'-failures.jsonl: 실패만 분리 저장.',
'- 테스트 실행 스크립트: scripts/ai-v3-online-110-verify.js',
'',
'이 보고서는 단일 Preview 배포의 관측 결과로 모든 상황에 대한 정확도 100%를 의미하지 않는다.'
];
const mdPath=path.join(dir,prefix+'.md'),jsonlPath=path.join(dir,prefix+'-results.jsonl'),
 failedPath=path.join(dir,prefix+'-failures.jsonl');
const jsonl=a=>a.map(x=>JSON.stringify(x)).join('\n')+'\n';
fs.writeFileSync(mdPath,md.join('\n')+'\n');
fs.writeFileSync(jsonlPath,jsonl(rows));
fs.writeFileSync(failedPath,jsonl(failed));
console.log(JSON.stringify({reports:[mdPath,jsonlPath,failedPath],oldReviewed:baseline,auto,reviewed,
  failIds:failed.map(x=>x.id),unverifiedIds:unverified.map(x=>x.id),tokens:summary.tokens}));
