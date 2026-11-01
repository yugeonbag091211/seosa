'use strict';
const assert=require('node:assert/strict');
const {shouldDisableGlobalGateForTest: disabled}=require('../api/_adpick');
const safe=[
 ['0','http://127.0.0.1:8455',true],
 ['0','http://localhost:8455',true],
 ['0','https://127.0.0.1:8455',true],
 ['0','https://biz.adpick.co.kr',false],
 ['0','https://sub.localhost.evil.example',false],
 ['0','https://127.0.0.1.evil.example',false],
 ['0','not a url',false],
 ['1','http://localhost:8455',false],
 [undefined,'http://localhost:8455',false]
];
for(const [flag,host,expect] of safe)assert.equal(disabled(flag,host),expect,host);
console.log('ADPICK_GLOBAL_GATE_SAFETY',JSON.stringify({pass:safe.length,fail:0,providerCalls:0,dbWrites:0}));
