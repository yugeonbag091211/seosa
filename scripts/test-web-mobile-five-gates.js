'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const f=p=>fs.readFileSync(path.resolve(__dirname,'..',p),'utf8');
const screen=f('apps/mobile/app/(tabs)/search.tsx');
const query=f('apps/mobile/lib/queries.ts');
const web=f('public/index.html');
let n=0;
for(const [label,cond] of [
 ['mobile displays partial supplier status',screen.includes("search.data.partialResults || search.data.blocked")],
 ['mobile displays partial stale',screen.includes("search.data.partialStale")],
 ['mobile does not claim no matches on outage',screen.includes("일부 판매처 가격을 확인하지 못했어요")],
 ['mobile checkout display price caveat',screen.includes("쿠폰·옵션·배송비는 판매처에서 확인해 주세요")],
 ['mobile partial cache not considered fresh',query.includes("query.state.data?.partialResults")&&query.includes("staleTime: query =>")],
 ['mobile does not automatically retry supplier requests',query.includes("retry: false")&&query.includes("refetchOnWindowFocus: false")],
 ['web marks supplier partial',web.includes("X-Seosa-Partial-Results")],
 ['web warns when one provider unavailable',web.includes("일부 쇼핑몰 상품을 지금 확인하지 못했어요")],
 ['web warns final paid amount may differ',web.includes("표시 가격은 최종 결제가가 아니에요")],
 ['web avoids stale price as all-market low',web.includes("결과 중 최저")],
 ]){assert.ok(cond,label);n++;}
console.log('WEB_MOBILE_FIVE_GATES',JSON.stringify({checked:n,pass:n,fail:0,realApiCalls:0}));
