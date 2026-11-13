'use strict';
const assert = require('assert');
const Module = require('module');
const original = Module._load;
let throwEngine = false;
Module._load = function(request, parent, isMain) {
  if (request === './_auth' && parent.filename.endsWith('_ai-v3-route.js')) return { identify: () => ({ ok: false }) };
  if (request === './_ai-v3-core' && parent.filename.endsWith('_ai-v3-route.js')) return { createEngine: async (_deps, body) => {
    if (throwEngine) throw new Error('simulated');
    return { status: 200, answer: body.message, cards: [], state: 'signed-state' };
  } };
  return original.apply(this, arguments);
};
const route = require('../api/_ai-v3-route');
Module._load = original;
const monitor = require('../api/_ai-v3-monitor');
const response = () => ({ statusCode: 200, headers: {}, setHeader(k,v){this.headers[k]=v}, status(n){this.statusCode=n;return this}, json(v){this.body=v;return this}, end(){return this} });
const request = () => ({ method:'POST', headers:{}, query:{v:'3'}, body:{question:'안녕하세요',sessionId:'abcdefghijklmnop'}, socket:{remoteAddress:'1.1.1.1'} });
(async () => {
  assert.strictEqual(route._assigned('abc', 0), false);
  assert.strictEqual(route._assigned('abc', 100), true);
  assert.strictEqual(route._assigned('abc', 35), route._assigned('abc', 35));
  let fallback = 0;
  const deps = { adapter:{}, searchProducts(){}, loadDisplayed(){}, assigned:()=>true,
    monitor:{healthy:async()=>true,record:async()=>true}, legacyHandler:async(req,res)=>{fallback++;assert.strictEqual(req.query.v,undefined); assert.strictEqual(req.body.question,'안녕하세요');return res.json({text:'legacy'})} };
  process.env.ENABLE_AI_V3='1'; process.env.AI_V3_ROLLOUT_PERCENT='100';
  let res = response(); await route._handler(request(),res,deps);
  assert.equal(res.headers['x-ai-version'],'v3'); assert.equal(res.body.answer,'안녕하세요');
  throwEngine=true; res=response(); await route._handler(request(),res,deps); assert.equal(res.headers['x-ai-version'],'legacy');
  throwEngine=false; res=response(); await route._handler(request(),res,{...deps,monitor:{...deps.monitor,healthy:async()=>false}}); assert.equal(res.headers['x-ai-version'],'legacy');
  process.env.AI_V3_ROLLOUT_PERCENT='0'; res=response(); await route._handler(request(),res,{...deps,assigned:route._assigned}); assert.equal(res.headers['x-ai-version'],'legacy'); assert.equal(fallback,3);
  const db = (total, errors) => ({from(){let fail=false; const q={select(){return q},eq(k,v){if(k==='success'&&v===false) fail=true;return q},gte(){return q},then(resolve){return Promise.resolve({count:fail?errors:total,error:null}).then(resolve)}};return q}});
  assert.equal(await monitor.healthy(db(10,1)),true); assert.equal(await monitor.healthy(db(10,2)),false); assert.equal(await monitor.healthy(db(0,0)),true);
  assert.equal(await monitor.healthy({from(){throw Error('down')}}),false);
  console.log('rollout and shared circuit checks passed');
})().catch(e=>{console.error(e);process.exitCode=1});
