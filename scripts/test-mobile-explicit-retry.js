'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ui=fs.readFileSync(path.resolve(__dirname,'../apps/mobile/app/(tabs)/search.tsx'),'utf8');
const api=fs.readFileSync(path.resolve(__dirname,'../apps/mobile/lib/api.ts'),'utf8');
const queries=fs.readFileSync(path.resolve(__dirname,'../apps/mobile/lib/queries.ts'),'utf8');
const checks={
 partialRetry:ui.includes('label="다시 조회"') && ui.includes('void search.refetch()'),
 loadedPartialRetry:ui.includes('판매처 다시 조회'),
 loadingGuard:ui.includes('if (!search.isFetching)'),
 noAutoRefetch:queries.includes('refetchOnWindowFocus: false') && queries.includes('refetchOnMount: false'),
 limitedNoAutoRetry:queries.includes('retry: false'),
 freshnessAware:queries.includes('query.state.data?.partialResults'),
 sourceGrounded:api.includes("r.headers.get('X-Seosa-Partial-Results') === '1'")
};
for(const [key,ok] of Object.entries(checks))assert.ok(ok,key);
console.log('MOBILE_EXPLICIT_RETRY',JSON.stringify({pass:Object.keys(checks).length,fail:0,externalCalls:0}));
