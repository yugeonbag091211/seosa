'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),src=path.join(root,'reports/ai-v3-online-20261105'),dst=path.join(root,'docs');
const read=n=>fs.readFileSync(path.join(src,n),'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const old=read('blind-before-20261106-repair.jsonl'),mid=read('blind-before-case-guard.jsonl'),latest=read('blind.jsonl');
const meta=JSON.parse(fs.readFileSync(path.join(src,'blind-summary.json'),'utf8'));
if([old,mid,latest].some(x=>x.length!==30)||meta.ran!==30||new Set(latest.map(x=>x.id)).size!==30)throw Error('Incomplete benchmark');
for(let i=0;i<30;i++)if(old[i].question!==latest[i].question||old[i].id!==latest[i].id)throw Error('Benchmark changed between builds');
const score=rows=>rows.reduce((a,r)=>(a[r.verdict]++,a),{PASS:0,FAIL:0,UNVERIFIED:0});
const s0=score(old),s1=score(mid),s2=score(latest);
const informational=new Set(['B024','B029','B030']);
const ss=score(latest.filter(x=>!informational.has(x.id)));
const clean=v=>String(v||'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ').slice(0,160);
const l=latest.map(x=>x.elapsedMs).filter(Number.isFinite).sort((a,b)=>a-b);
const percentile=n=>(Math.round(l[Math.max(0,Math.ceil(n*l.length)-1)]/10)/100);
const risk={
 B012:'맥북 호환 여부가 판매 제목에 직접 명시되지 않음',
 B014:'1TB SSD 용량과 판매가를 제조사·판매처에서 추가 확인 필요',
 B020:'저가 로봇청소기 실제 사양 및 옵션 검증 필요',
 B021:'두 청소기 유형·사양이 달라 성능 비교 시 주의',
 B025:'신품 여부가 판매 제목만으로 확인되지 않는 후보 포함'
};
const rows=latest.map(x=>({id:x.id,question:x.question,verdict:x.verdict,errors:x.errors,unverified:x.unverified,http:x.http,elapsedMs:x.elapsedMs,stats:x.stats,state:x.state,cards:x.cards.map(c=>({title:c.title,price:c.price,condition:c.condition})),risk:risk[x.id]||null}));
const pref='ai-v31-new-30-live-audit-2026-11-06';
const md=[
'# SEOSA AI v3.1 — 신규 30문항 실전 검증 보고서','',
'작성일: 2026-11-06 (KST). Production 미변경.',
'',
'브랜치: feat/ai-v31-engine-20261106',
'커밋: 0c5ad84764027607106e82c6be98d21621d73d83',
'Preview: https://seosa-e7romu2cw-seosa.vercel.app (접근 보호)',
'Neon migration-test-20261020 / seosa_v3_reader 읽기 전용',
'',
'## 자동 판정 비교','',
'| 버전 | PASS | FAIL | 미검증 | 합계 |','|---|---:|---:|---:|---:|',
'| 최초 신규 실전 | '+s0.PASS+' | '+s0.FAIL+' | '+s0.UNVERIFIED+' | 30 |',
'| 1차 보완 후 | '+s1.PASS+' | '+s1.FAIL+' | '+s1.UNVERIFIED+' | 30 |',
'| 최종 보완 후 | '+s2.PASS+' | '+s2.FAIL+' | '+s2.UNVERIFIED+' | 30 |',
'',
'최종 30문항 중 정보성·인사 3문항은 PASS 3건이다. 실제 쇼핑 27문항은 PASS '+ss.PASS+', FAIL '+ss.FAIL+', 미검증 '+ss.UNVERIFIED+'건이다.',
'초기 FAIL 두 건은 사용자가 요구한 중고를 실패로 보는 문제 및 묶음 제외어 판정 오류가 포함되었다. PASS 변화는 평가기 수정도 포함하므로 직접적인 추천 정확도 개선율이 아니다.',
'상품을 찾지 못한 상황을 확정 성공으로 간주하지 않는다. 판매가·재고·정품·배송비는 별도 출처 검증이 필요하다.',
'',
'## 수정에 따른 실제 동작','',
'- B006: 버즈3 프로 한쪽 낱개 유닛과 타사 이어폰 오추천 차단. 최종 미검증.',
'- B011: 아이패드 에어 11 M4 키보드에 프로 11·에어 13 케이스 혼입 차단. 최종 미검증.',
'- B012: 맥북은 연결 대상이고 512GB 외장 SSD가 구매 대상이라는 구분 유지.',
'- B016: 마우스 결합 세트 제외 판정의 잘못된 마우스 단어 강제를 수정.',
'- B020: 로봇청소기 먼지봉투 및 수납장 판매글을 본체로 추천하지 않음.',
'- B026: 중고 노트북 명시 요청을 허용하고 랜덤 모델·복수 옵션 상품을 제외.',
'',
'## 읽기 전용 DB 현황','',
'- S25 기본 256GB 자급제 검색 제목은 있으나 모델 변형/등급 혼합으로 상태 확정이 어렵다.',
'- 아이패드 11인치 블루투스 키보드 검색에는 Pro 11 전용 케이스가 확인됐고 Air 11 M4 호환 근거는 확인되지 않았다.',
'- 512GB 외장 SSD 저가 제목은 복수 용량 옵션 상품이 포함되어 상세 옵션 가격 확인이 필요하다.',
'- 24인치 삼성 모니터의 저가 기록은 여러 크기가 섞인 중고 묶음 판매글이다.',
'',
'## 실제 GPT와 응답시간','',
'| 지표 | 값 |','|---|---:|',
'| 성공 HTTP 200 | '+latest.filter(x=>x.http===200).length+' / 30 |',
'| GPT 호출 | '+meta.tokens.calls+' |',
'| 입력 토큰 | '+meta.tokens.input+' |',
'| 출력 토큰 | '+meta.tokens.output+' |',
'| p50 | '+percentile(.5)+'초 |',
'| p95 | '+percentile(.95)+'초 |',
'| 전체 시간 | '+meta.elapsedSeconds+'초 |','',
'실제 모델 청구 금액은 별도 계측 대조 전이므로 확정하지 않는다.',
'',
'## 상품 제목 외 추가 검증이 필요한 항목','',
...Object.entries(risk).map(([id,txt])=>'- '+id+': '+txt),
'',
'## 문항별 결과','',
'| ID | 실제 질문 | 자동 판정 | 상품 수 | 추가 확인 |','|---|---|---|---:|---|',
...rows.map(x=>'| '+x.id+' | '+clean(x.question)+' | '+x.verdict+' | '+x.cards.length+' | '+clean(x.risk||x.unverified.join(',')||x.errors.join(','))+' |'),
'',
'## 다음 단계','',
'- 미검증 10건의 DB 실재고, 모델 정확도, 판매처 옵션 가격을 추가 확인',
'- 제조사 사양, 신품 여부, 진품과 최종 배송비를 사용자 구매 화면과 교차 확인',
'- 새로운 비공개 질문 50~100개로 일반화 평가: 이번 30문항은 수정에 사용되어 이제 완전히 블라인드가 아님',
'- GPT 비용 및 쿼리 지연, DB 부하를 실계측하고 별도 승인 없이 Production 배포 금지',
'',
'## 첨부 파일','',
'- '+pref+'-results.jsonl: 문항별 상태·상품 제목·가격·토큰. 제휴 클릭 URL 및 인증 토큰 제외',
'- '+pref+'-unverified.jsonl: 미검증만 추출',
'- '+pref+'-risks.json: 수동 확인 목록과 지표',
'',
'PASS는 자동 규칙 통과이며 100% 구매 정확도를 보장하지 않는다.'
];
fs.writeFileSync(path.join(dst,pref+'.md'),md.join('\n')+'\n');
fs.writeFileSync(path.join(dst,pref+'-results.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
fs.writeFileSync(path.join(dst,pref+'-unverified.jsonl'),rows.filter(x=>x.verdict==='UNVERIFIED').map(x=>JSON.stringify(x)).join('\n')+'\n');
fs.writeFileSync(path.join(dst,pref+'-risks.json'),JSON.stringify({flags:risk,scores:{original:s0,intermediate:s1,final:s2,shopping:ss},p50s:percentile(.5),p95s:percentile(.95),tokens:meta.tokens},null,2)+'\n');
console.log(JSON.stringify({old:s0,mid:s1,final:s2,shopping:ss,p50:percentile(.5),p95:percentile(.95),tokens:meta.tokens,cards:rows.reduce((a,x)=>a+x.cards.length,0),outputs:[pref+'.md',pref+'-results.jsonl',pref+'-unverified.jsonl',pref+'-risks.json']}));
