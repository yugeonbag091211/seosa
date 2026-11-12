'use strict';
const fs=require('node:fs'), path=require('node:path');
const {cases}=require('./ai-v31-online-200-cases');
const {isPart,productTypeMatches,canonicalCategory,familyCategory}=require('../api/_ai-v31-taxonomy');
const {requestedIdentity,checkListingIdentity}=require('../api/_ai-v3-identity');
const base=path.resolve(__dirname,'..'),dir=path.join(base,'reports/ai-v3-online-20261105'),out=path.join(base,'docs');
const prefix='ai-v31-online-200-2026-11-06';
const rows=fs.readFileSync(path.join(dir,'online200.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const sum=JSON.parse(fs.readFileSync(path.join(dir,'online200-summary.json'),'utf8'));
if(rows.length!==200 || sum.ran!==200)throw new Error('Incomplete online test '+rows.length+'/'+sum.ran);
if(new Set(rows.map(x=>x.id)).size!==200 || new Set(rows.map(x=>x.question)).size!==200)throw new Error('Duplicate questions or ids');
const lookup=new Map(cases.map(x=>[x.id,x]));
if(rows.some(x=>lookup.get(x.id)?.p!==x.question))throw new Error('Question corpus does not match');
const scores={PASS:0,FAIL:0,UNVERIFIED:0},groups={},risk=[];
const esc=s=>String(s||'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ').slice(0,170);
for(const item of rows){
 scores[item.verdict]++;
 const t=lookup.get(item.id),group=t.cat||'비쇼핑';
 const g=groups[group]||(groups[group]={total:0,PASS:0,FAIL:0,UNVERIFIED:0,cards:0});
 g.total++;g[item.verdict]++;g.cards+=(item.cards||[]).length;
 const expected=requestedIdentity(t.p);
 for(const [idx,c] of (item.cards||[]).entries()){
  const title=String(c.title||''),suspected=[],caution=[];
  if(t.cat && isPart(title,t.cat))suspected.push('accessory');
  if(t.cat && !productTypeMatches(title,t.cat,t.p))suspected.push('category_or_features');
  if(expected.family && familyCategory(expected.family)===canonicalCategory({planCategory:t.cat})){
    const match=checkListingIdentity(title,expected);
    if(!match.ok)suspected.push('identity_'+match.field);
  }
  if(/(?:통신사이동|번호이동|약정|할부원금|공통지원금)/i.test(title)&&
    !/(?:약정|할부|통신사)/i.test(t.p))suspected.push('conditional_price');
  if(/(?:랜덤발송|모델선택|옵션선택|골라담기)/i.test(title))suspected.push('ambiguous_option');
  if(/(?:중고|리퍼|개봉|재포장|전시상품)/i.test(title)&&/(?:신품|새상품|새제품|미개봉)/i.test(t.p))
    caution.push('condition_not_verified');
  if(t.cat==='외장하드'&&/ssd/i.test(t.p)&&/1\s*tb/i.test(title)&&Number(c.price)<50000)
    caution.push('low_price_needs_confirmation');
  if(t.cat==='시계'&&/(?:스트랩|충전독|밴드)/i.test(title))caution.push('watch_accessory_possibility');
  if(t.cat==='기타'&&/(?:기타줄|기타\s*케이스|픽업\s*부품|헤드폰앰프)/i.test(title))
    caution.push('guitar_accessory_possibility');
  if(/(?:\d+\s*GB|\d+\s*TB).{1,25}(?:\d+\s*GB|\d+\s*TB)/i.test(title))
    caution.push('multiple_capacity_options');
  if(suspected.length||caution.length)risk.push({id:item.id,question:item.question,card:idx+1,title:title.slice(0,240),price:c.price,suspected,caution});
 }
}
const times=rows.map(x=>x.elapsedMs).filter(Number.isFinite).sort((a,b)=>a-b);
const q=n=>Math.round((times[Math.max(0,Math.ceil(n*times.length)-1)]||0)/10)/100;
const avg=Math.round(times.reduce((a,b)=>a+b,0)/times.length/10)/100;
const cleaned=rows.map(x=>({id:x.id,question:x.question,category:lookup.get(x.id).cat||'비쇼핑',verdict:x.verdict,http:x.http,elapsedMs:x.elapsedMs,from:x.from,errors:x.errors,unverified:x.unverified,state:x.state,stats:x.stats,cards:(x.cards||[]).map(c=>({title:c.title,price:c.price,condition:c.condition}))}));
const fail=cleaned.filter(x=>x.verdict==='FAIL'),unverified=cleaned.filter(x=>x.verdict==='UNVERIFIED');
const maybeWrong=risk.filter(x=>x.suspected.length);
const metrics={questions:200,scores,groups,http200:rows.filter(x=>x.http===200).length,http429:rows.filter(x=>x.http===429).length,http5xx:rows.filter(x=>x.http>=500).length,tokens:sum.tokens,p50Seconds:q(.5),p95Seconds:q(.95),avgSeconds:avg,elapsedSeconds:sum.elapsedSeconds,suspectCards:maybeWrong.length,riskyCards:risk.length,preview:sum.deploy};
const md=[
'# SEOSA AI v3.1 온라인 200문항 검증 보고서','',
'검증일: 2026-11-06 KST',
'검증 대상 Preview: '+sum.deploy,
'기준 서버 커밋: 6647d0b35bc6db5e80024b1e8caeef5747ba2f5a',
'Neon 테스트 브랜치의 읽기 전용 DB를 사용했고 Production은 변경하지 않음.',
'기존 시험 질문과 겹치지 않는 200문항. 14개 쇼핑 분야, 24개 연속 대화 턴, 비쇼핑 8개 포함.',
'',
'## 전체 자동 판정','',
'| 판정 | 문항 | 비율 |','|---|---:|---:|',
'| PASS | '+scores.PASS+' | '+(scores.PASS/2).toFixed(1)+'% |',
'| FAIL | '+scores.FAIL+' | '+(scores.FAIL/2).toFixed(1)+'% |',
'| UNVERIFIED | '+scores.UNVERIFIED+' | '+(scores.UNVERIFIED/2).toFixed(1)+'% |',
'| 합계 | 200 | 100% |','',
'자동 PASS는 검색·모델·상품명·가격 조건 등 코드 검사를 통과했다는 뜻이며 최종 구매 정확도는 아님.',
'상품명 기반 추가 검사에서 잠재적 오류 '+maybeWrong.length+'개 카드, 판매처 검증 주의 포함 총 '+risk.length+'개 카드를 별도로 표시함.',
'',
'## 실제 호출·성능','',
'| 항목 | 값 |','|---|---:|',
'| HTTP 200 | '+metrics.http200+' / 200 |',
'| HTTP 429 | '+metrics.http429+' |',
'| HTTP 5xx | '+metrics.http5xx+' |',
'| GPT 호출 | '+sum.tokens.calls+' |',
'| 입력 토큰 | '+sum.tokens.input+' |',
'| 출력 토큰 | '+sum.tokens.output+' |',
'| 평균 응답 | '+avg+'초 |',
'| p50 | '+q(.5)+'초 |',
'| p95 | '+q(.95)+'초 |',
'| 실행 소요 | '+sum.elapsedSeconds+'초 |','',
'모델 공급자 청구서와 대조하지 않아 실제 달러 비용은 확정하지 않는다.',
'',
'## 카테고리별 검증','',
'| 상품 분야 | 총 문항 | PASS | FAIL | 미검증 | 상품 카드 |','|---|---:|---:|---:|---:|---:|',
...Object.entries(groups).map(([name,s])=>'| '+name+' | '+s.total+' | '+s.PASS+' | '+s.FAIL+' | '+s.UNVERIFIED+' | '+s.cards+' |'),
'',
'## 자동 FAIL 질문','',
'| ID | 질문 | 실패 사유 |','|---|---|---|',
...fail.map(x=>'| '+x.id+' | '+esc(x.question)+' | '+esc(x.errors.join(', '))+' |'),
'',
'## 미검증 질문','',
'| ID | 질문 | 근거 부족 |','|---|---|---|',
...unverified.map(x=>'| '+x.id+' | '+esc(x.question)+' | '+esc(x.unverified.join(', '))+' |'),
'',
'## 상품명 재검토가 필요한 사례','',
'| ID | 판매 상품 제목 | 의심 항목 |','|---|---|---|',
...maybeWrong.map(x=>'| '+x.id+' | '+esc(x.title)+' | '+esc(x.suspected.join(', '))+' |'),
'',
'## 전체 200문항 기록','',
'| ID | 원문 질문 | 자동 판정 | 카드 수 | 비고 |','|---|---|---:|---:|---|',
...cleaned.map(x=>'| '+x.id+' | '+esc(x.question)+' | '+x.verdict+' | '+x.cards.length+' | '+esc([...x.errors,...x.unverified].join(', '))+' |'),
'',
'## 해석·제한','',
'- 제품명이 맞아도 구매가, 실제 재고, 배송비, 정품, 선택 옵션 등은 판매처 독립 확인 전에는 보증할 수 없음.',
'- 미검증은 DB에 해당 상품이 없거나 검색이 놓쳤을 가능성을 모두 포함하므로 성공 처리하지 않음.',
'- 추가 검사 결과는 상품명 기반의 의심 플래그이며 판매처 조사 없이 모두 확정 오추천으로 볼 수 없음.',
'- 향후 코드 개선 후에는 이 200문항을 재사용할 수 있지만 새로운 독립 홀드아웃 문항도 필요.',
'- Production 반영은 별도 승인 후에만 진행.',
'',
'## 관련 결과','',
'- '+prefix+'-results.jsonl: 질문 원문·상태·상품명·가격 (인증/제휴 URL 제외)',
'- '+prefix+'-failures.jsonl: FAIL 전수',
'- '+prefix+'-unverified.jsonl: 미검증 전수',
'- '+prefix+'-risk-cards.jsonl: 제목 기반 의심·위험 후보',
'- '+prefix+'-summary.json: 원시 지표와 카테고리별 결과'
];
fs.writeFileSync(path.join(out,prefix+'.md'),md.join('\n')+'\n');
const jsonl=a=>a.map(x=>JSON.stringify(x)).join('\n')+'\n';
for(const [name,r] of [['results',cleaned],['failures',fail],['unverified',unverified],['risk-cards',risk]])
 fs.writeFileSync(path.join(out,prefix+'-'+name+'.jsonl'),jsonl(r));
fs.writeFileSync(path.join(out,prefix+'-summary.json'),JSON.stringify(metrics,null,2)+'\n');
console.log(JSON.stringify(metrics));
