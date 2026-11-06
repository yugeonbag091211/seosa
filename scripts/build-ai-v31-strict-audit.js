'use strict';
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),logs=path.join(root,'reports','ai-v3-online-20261105'),docs=path.join(root,'docs');
const load=(name)=>JSON.parse(fs.readFileSync(path.join(logs,name),'utf8'));
const lines=(name)=>fs.readFileSync(path.join(logs,name),'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const sample=lines('holdout.jsonl'),fixed=lines('critical.jsonl'),baseline=load('full-summary.json'),s=load('holdout-summary.json'),c=load('critical-summary.json');
if(sample.length!==20||fixed.length!==2||baseline.ran!==100||s.ran!==20||c.ran!==2)throw Error('Incomplete live validation');
if(new Set(sample.map(x=>x.question)).size!==20)throw Error('Duplicate questions');
const scores=list=>list.reduce((a,x)=>(a[x.verdict]++,a),{PASS:0,FAIL:0,UNVERIFIED:0});
const x=scores(sample),y=scores(fixed);
const esc=s=>String(s||'').replace(/\|/g,'\\|').replace(/[\r\n]/g,' ').slice(0,190);
const prefix='ai-v31-strict-evaluation-2026-11-06',file=path.join(docs,prefix+'.md');
const out=sample.map(r=>({id:r.id,question:r.question,verdict:r.verdict,errors:r.errors,
 unverified:r.unverified,cards:r.cards.map(c=>({title:c.title,price:c.price,condition:c.condition})),
 category:r.state?.category,minPrice:r.state?.minPrice,maxPrice:r.state?.maxPrice,
 shownCount:r.state?.presentedProductIds?.length,modelUsage:r.stats?.modelUsage}));
const dump=(name,arr)=>fs.writeFileSync(path.join(docs,prefix+name+'.jsonl'),arr.map(x=>JSON.stringify(x)).join('\n')+(arr.length?'\n':''));
dump('-results',out);dump('-failures',out.filter(x=>x.verdict==='FAIL'));
dump('-unverified',out.filter(x=>x.verdict==='UNVERIFIED'));
const md=[
 '# SEOSA AI v3.1: 강화 온라인 검증 보고서',
 '',
 '작성일: 2026-11-06 (KST). Production은 변경하지 않았습니다.',
 '',
 '## 대상과 방법',
 '',
 '- 브랜치: feat/ai-v31-engine-20261106',
 '- 강화 20문항 대상 커밋: 844751a36d60be0d57ce4d56be86831e9f0c2d81',
 '- 강화 20문항 Preview: https://seosa-flo4tdqo5-seosa.vercel.app (접근 보호)',
 '- 마지막 수정 검증 커밋: 91a877cb1d9969a2aaa33d7a132fc8fa1fab4314',
 '- 마지막 수정 Preview: https://seosa-plzisvj0x-seosa.vercel.app (접근 보호)',
 '- 데이터베이스: Neon migration-test-20261020 / 읽기 전용 seosa_v3_reader',
 '- 실제 GPT 사용, 상품 DB 읽기 전용, 서로 다른 20문항, 후속 질문은 이전 상태 전달',
 '- 오프라인 회귀 검사: 162/162 PASS (엔진 53, 검증기 8, 코어 40, 기기 식별 48, 카탈로그 13)',
 '',
 '## 결과',
 '',
 '| 검증 | PASS | FAIL | 미검증 | 전체 |',
 '|---|---:|---:|---:|---:|',
 '| 과거 v3 동일 100문항 (구 자동 기준) | 74 | 2 | 24 | 100 |',
 '| v3.1 동일 100문항 (구 자동 기준) | '+baseline.scores.PASS+' | '+baseline.scores.FAIL+' | '+baseline.scores.UNVERIFIED+' | 100 |',
 '| 강화 기준 20문항 | '+x.PASS+' | '+x.FAIL+' | '+x.UNVERIFIED+' | 20 |',
 '| 최신 보완 2문항 집중 재시험 | '+y.PASS+' | '+y.FAIL+' | '+y.UNVERIFIED+' | 2 |',
 '',
 '주의: 100문항과 강화 20문항은 판정 규칙이 달라 성능 차이를 곧바로 정확도로 환산할 수 없습니다. 마지막 2문항은 다른 커밋에서 검사했으며 최신 전체 20문항을 다시 실행한 결과는 아닙니다.',
 '',
 '## GPT 계측',
 '',
 '| 구간 | 호출 | 입력 토큰 | 출력 토큰 |',
 '|---|---:|---:|---:|',
 '| 강화 20문항 | '+s.tokens.calls+' | '+s.tokens.input+' | '+s.tokens.output+' |',
 '| 마지막 2문항 | '+c.tokens.calls+' | '+c.tokens.input+' | '+c.tokens.output+' |',
 '',
 '달러 실제 청구액은 조회하지 않았습니다.',
 '',
 '## 강화 20문항 상세',
 '',
 '| ID | 질문 | 판정 | 반환 상품 수 | 사유 |',
 '|---|---|---|---:|---|',
 ...out.map(r=>'| '+r.id+' | '+esc(r.question)+' | '+r.verdict+' | '+r.cards.length+' | '+esc(r.errors.join(', ')||r.unverified.join(', '))+' |'),
 '',
 '## 최신 수정의 집중 재시험',
 '',
 '| ID | 질문 | 판정 | 반환 상품 수 |',
 '|---|---|---|---:|',
 ...fixed.map(r=>'| '+r.id+' | '+esc(r.question)+' | '+r.verdict+' | '+r.cards.length+' |'),
 '',
 '## 주요 수정',
 '',
 '- GPT가 쇼핑 질문의 검색어를 비워도 서버에서 사용자가 밝힌 종류를 복원합니다.',
 '- 이전에 보여준 목록에서 고르라는 뜻인 그중 후속 질문은 이전 상품 ID만 대상으로 합니다.',
 '- 저장장치 케이블, 태블릿용 메모리카드, 청소기 먼지봉투, 자급제 근거가 없는 휴대폰, 렌탈 가격을 본체의 일반 판매가로 간주하지 않습니다.',
 '- 태블릿과 액정타블렛, 갤럭시 S25와 S25 Edge, 아이패드 Air와 Pro 케이스를 구분합니다.',
 '- 옵션 용량이 불분명하면 검증 가능한 용량 정보 없이 가격을 확정하지 않습니다.',
 '',
 '## 해석 및 남은 위험',
 '',
 '- 상품을 찾지 못하면 기본적으로 미검증입니다. 실제 품절, DB 누락, 검색 누락은 각각 추가 조사가 필요합니다.',
 '- 판정 PASS는 자동 검증 통과이지 진품·사양·사용 가능 여부·최종 배송비·구매 가격·재고를 모두 독립 확인했다는 뜻이 아닙니다.',
 '- 결과를 바탕으로 수정한 20문항은 이제 완전한 블라인드 홀드아웃이 아닙니다. 새로운 미공개 질문으로 일반화 성능을 다시 측정해야 합니다.',
 '- Production 변경 전 새로운 질문 50~100개, DB 부하, 가격 출처, 장시간 대화 및 장애 처리 확인이 필요합니다.',
 '',
 '## 산출물',
 '',
 '- '+prefix+'-results.jsonl : 문항별 판정, 실제 카드명, 기록 가격 (제휴 링크·인증 토큰 제외)',
 '- '+prefix+'-failures.jsonl : 확정 FAIL (이 시험에서는 빈 파일)',
 '- '+prefix+'-unverified.jsonl : 미검증 6건',
 '- 스크립트: scripts/ai-v3-online-110-verify.js',
 ''
];
fs.writeFileSync(file,md.join('\n'));
console.log(JSON.stringify({report:file,counts:x,critical:y,unverified:out.filter(r=>r.verdict==='UNVERIFIED').map(r=>r.id),sha:'91a877c'}));
