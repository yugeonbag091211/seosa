'use strict';
// Server-only, opt-in Supabase/PostgREST compatibility layer for Neon PostgreSQL.
// See docs/migration/neon-r2-runbook.md. No browser-facing connection string.
const { Pool } = require('pg');
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = input => {
  if (!IDENT.test(input)) throw new Error('Unsafe SQL identifier');
  return '"' + input + '"';
};
const value = input => input && typeof input === 'object' && !Array.isArray(input) && !(input instanceof Date) ? JSON.stringify(input) : input;
const errs = e => ({ message:e && e.message || 'Database error', code:e && e.code || 'NEON_SQL_ERROR', details:null, hint:null });
const keyFor = x => Object.keys(x || {});
let pool;
function getPool() {
  if (pool) return pool;
  if (process.env.SEOSA_DB_BACKEND !== 'neon' || process.env.SEOSA_NEON_EXPERIMENTAL !== '1') throw Error('Neon adapter explicitly disabled');
  if (process.env.VERCEL_ENV === 'production' && process.env.SEOSA_NEON_PRODUCTION_APPROVED !== '1') throw Error('Neon production transition not approved');
  const connectionString = process.env.NEON_DATABASE_URL;
  if (!connectionString || !/^postgres(ql)?:\/\//.test(connectionString)) throw Error('NEON_DATABASE_URL missing or invalid');
  // node-postgres validates the server certificate against trusted system roots.
  pool = new Pool({connectionString,ssl:{rejectUnauthorized:true},max:4,idleTimeoutMillis:10000,connectionTimeoutMillis:10000});
  return pool;
}
function filterSql(k,op,v,args) {
  const col = quote(k);
  if (op==='is') {
    if (v===null || v==='null') return col+' IS NULL';
    if (v===true || v==='true') return col+' IS TRUE';
    if (v===false || v==='false') return col+' IS FALSE';
    throw Error('Invalid IS value');
  }
  if (op==='in') {
    if (!Array.isArray(v)) throw Error('IN requires array');
    if (!v.length) return 'FALSE';
    return col+' IN ('+v.map(x=>{args.push(value(x));return '$'+args.length;}).join(',')+')';
  }
  const operators = {eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<=',like:'LIKE',ilike:'ILIKE'};
  if (!operators[op]) throw Error('Unsupported filter: '+op);
  args.push(value(v));
  return col+' '+operators[op]+' $'+args.length;
}
function asPostgrestFilter(expr,args) {
  // Supported safe subset of Supabase PostgREST OR syntax: column.operator.value.
  const parts=String(expr).split(',').filter(Boolean);
  if (!parts.length || parts.length>20) throw Error('Unsupported OR filter');
  return '('+parts.map(part=>{
    const m=/^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq|gt|gte|lt|lte|like|ilike|is)\.(.*)$/s.exec(part.trim());
    if (!m) throw Error('Unsupported OR expression');
    return filterSql(m[1],m[2],m[3],args);
  }).join(' OR ')+')';
}
function selectColumns(cols) {
  const c=String(cols||'*').trim();
  if(c==='*') return '*';
  const tokens = c.split(',').map(s=>s.trim());
  if(tokens.length>80 || tokens.some(s=>!/^([A-Za-z_][A-Za-z0-9_]*)(:([A-Za-z_][A-Za-z0-9_]*))?$/.test(s))) throw Error('Unsupported projection');
  return tokens.map(t=>{
    const a=t.split(':');
    return a.length===2?quote(a[1])+' AS '+quote(a[0]):quote(a[0]);
  }).join(',');
}
class Query {
  constructor(table,exec){this.table=table;this.exec=exec;this.op='select';this.columns='*';this.filters=[];this.orders=[];this.maxRows=1000;this.offset=0;this.singleMode=null;this.options={};this.payload=null;this.onConflict=null;this.ignoreDuplicates=false;this.wantReturning=false;this.returning='*';this.otherLimit=null;}
  select(columns='*', opts={}) {this.columns=columns;this.options={...this.options,...opts};if(this.op!=='select'){this.wantReturning=true;this.returning=columns;}return this;}
  eq(k,v){this.filters.push({k,op:'eq',v});return this;}
  neq(k,v){this.filters.push({k,op:'neq',v});return this;}
  gt(k,v){this.filters.push({k,op:'gt',v});return this;}
  gte(k,v){this.filters.push({k,op:'gte',v});return this;}
  lt(k,v){this.filters.push({k,op:'lt',v});return this;}
  lte(k,v){this.filters.push({k,op:'lte',v});return this;}
  like(k,v){this.filters.push({k,op:'like',v});return this;}
  ilike(k,v){this.filters.push({k,op:'ilike',v});return this;}
  is(k,v){this.filters.push({k,op:'is',v});return this;}
  in(k,v){this.filters.push({k,op:'in',v});return this;}
  match(obj){for(const [k,v] of Object.entries(obj||{})) this.eq(k,v);return this;}
  or(expr){this.filters.push({or:expr});return this;}
  not(k,op,v){this.filters.push({not:true,k,op,v});return this;}
  filter(k,op,v){this.filters.push({k,op,v});return this;}
  order(k,opts={}) {this.orders.push({k,...opts});return this;}
  limit(n){this.maxRows=n;return this;}
  range(from,to){this.offset=from;this.maxRows=to-from+1;return this;}
  single(){this.singleMode='single';return this;}
  maybeSingle(){this.singleMode='maybe';return this;}
  insert(rows,opts={}){this.op='insert';this.payload=rows;this.options={...this.options,...opts};return this;}
  upsert(rows,opts={}){this.op='upsert';this.payload=rows;this.onConflict=opts.onConflict;this.ignoreDuplicates=Boolean(opts.ignoreDuplicates);this.options={...this.options,...opts};return this;}
  update(data){this.op='update';this.payload=data;return this;}
  delete(){this.op='delete';return this;}
  throwOnError(){this.raise=true;return this;}
  then(resolve,reject){return this.run().then(resolve,reject);}
  async run(){
    try{
      const r=await this.execute();
      return r;
    }catch(e){
      if(this.raise) throw e;
      return {data:null,error:errs(e),count:null,status:400,statusText:'Bad Request'};
    }
  }
  buildFilters(args) {
    if(this.filters.length>60) throw Error('Too many filters');
    return this.filters.map(f=>{
      const expr=f.or?asPostgrestFilter(f.or,args):filterSql(f.k,f.op,f.v,args);
      return f.not?'NOT ('+expr+')':expr;
    }).join(' AND ');
  }
  assertPaging(){
    if(this.maxRows!=null && (!Number.isInteger(this.maxRows)||this.maxRows<0||this.maxRows>10000)) throw Error('Unsafe limit');
    if(!Number.isInteger(this.offset)||this.offset<0) throw Error('Unsafe offset');
  }
  async execute(){
    const args=[], tbl='public.'+quote(this.table);
    this.assertPaging();
    const filters=this.buildFilters(args);
    const where=filters?' WHERE '+filters:'';
    let text,returnRows=true,needCount=this.options.count==='exact',count=null;
    if(this.op==='select'){
      const fields=selectColumns(this.columns);
      text='SELECT '+fields+' FROM '+tbl+where;
      if(this.orders.length){
        text+=' ORDER BY '+this.orders.map(o=>quote(o.k)+(o.ascending===false?' DESC':' ASC')+(o.nullsFirst===true?' NULLS FIRST':o.nullsFirst===false?' NULLS LAST':'')).join(',');
      }
      if(this.maxRows!=null){args.push(this.maxRows);text+=' LIMIT $'+args.length;}
      if(this.offset){args.push(this.offset);text+=' OFFSET $'+args.length;}
      if(needCount){
        const cArgs=[];const cWhere=this.buildFilters(cArgs);
        const r=await this.exec('SELECT COUNT(*)::bigint AS count FROM '+tbl+(cWhere?' WHERE '+cWhere:''),cArgs);
        count=Number(r.rows[0].count);
      }
      if(this.options.head===true) return {data:null,error:null,count,status:200};
    }else if(this.op==='insert'||this.op==='upsert'){
      const rows=Array.isArray(this.payload)?this.payload:[this.payload];
      if(!rows.length||rows.length>500)throw Error('Unsafe bulk operation size');
      const keys=keyFor(rows[0]);
      if(!keys.length || keys.length>100)throw Error('Invalid insert payload');
      const cols=keys.map(quote).join(',');
      const chunks=rows.map(row=>{
        if(keys.length!==keyFor(row).length||keys.some(k=>!(k in row))) throw Error('Inconsistent bulk fields');
        return '('+keys.map(k=>{args.push(value(row[k]));return '$'+args.length;}).join(',')+')';
      });
      text='INSERT INTO '+tbl+' ('+cols+') VALUES '+chunks.join(',');
      if(this.op==='upsert'){
        const conf=String(this.onConflict||'').split(',').map(x=>x.trim()).filter(Boolean);
        if(!conf.length) throw Error('Upsert conflict target must be explicit');
        text+=' ON CONFLICT ('+conf.map(quote).join(',')+')';
        if(this.ignoreDuplicates)text+=' DO NOTHING';
        else{
          const changes=keys.filter(k=>!conf.includes(k));
          text+=changes.length?' DO UPDATE SET '+changes.map(k=>quote(k)+'=EXCLUDED.'+quote(k)).join(','):' DO NOTHING';
        }
      }
      returnRows=this.wantReturning;
      if(returnRows) text+=' RETURNING '+selectColumns(this.returning);
    }else if(this.op==='update'){
      if(!filters)throw Error('Refuse unfiltered UPDATE');
      const keys=keyFor(this.payload);
      if(!keys.length||keys.length>100)throw Error('Empty update');
      const sets=keys.map(k=>{args.push(value(this.payload[k]));return quote(k)+'=$'+args.length;});
      text='UPDATE '+tbl+' SET '+sets.join(',')+where;
      returnRows=this.wantReturning;
      if(returnRows) text+=' RETURNING '+selectColumns(this.returning);
    }else if(this.op==='delete'){
      if(!filters)throw Error('Refuse unfiltered DELETE');
      text='DELETE FROM '+tbl+where;returnRows=this.wantReturning;
      if(returnRows)text+=' RETURNING '+selectColumns(this.returning);
    }else throw Error('Unsupported query');
    const r=await this.exec(text,args);
    let data=returnRows?r.rows:null;
    if(returnRows&&this.singleMode){
      if(r.rows.length>1 || (this.singleMode==='single'&&r.rows.length!==1))throw Error('Single row expected');
      data=r.rows[0]||null;
    }
    return {data,error:null,count,status:200};
  }
}
function createClient(options={}){
  const query=options.query||((text,args)=>getPool().query(text,args));
  return {
    from(name){quote(name);return new Query(name,query);},
    rpc(name,params={}){
      quote(name);
      const entries=Object.entries(params||{});
      const args=entries.map(([k,v])=>value(v));
      const argSql=entries.map(([k],i)=>quote(k)+' => $'+(i+1)).join(',');
      // Function result shape follows PostgREST for simple JSON/scalar and SETOF TABLE.
      const build=async()=>{
        try{
          const meta=await query('SELECT p.proretset, p.prorettype::regtype::text AS rettype FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=\'public\' AND p.proname=$1 AND p.prokind=\'f\' ORDER BY p.oid LIMIT 1',[name]);
          if(!meta.rows.length) throw Error('Unknown RPC');
          const r=await query('SELECT * FROM public.'+quote(name)+'('+argSql+')',args);
          const row=r.rows[0], columns=row&&Object.keys(row);
          let data;
          if(meta.rows[0].proretset) data=r.rows;
          else data=columns&&columns.length===1?row[columns[0]]:(row||null);
          return {data,error:null,count:null,status:200};
        }catch(e){return {data:null,error:errs(e),count:null,status:400};}
      };
      const proxy={
        then(onfulfilled,onrejected){return build().then(onfulfilled,onrejected);},
        range(start,end){this.rangeArgs=[start,end];return this;},
        limit(n){this.limitArg=n;return this;}
      };
      // Recreate rpc SQL for paging only when requested; no fallback to whole-result allocation.
      const oldBuild=build;
      let f=oldBuild;
      const run=async()=>{
        if(proxy.rangeArgs||proxy.limitArg!=null){
          try{
            const meta=await query('SELECT p.proretset FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=\'public\' AND p.proname=$1 AND p.prokind=\'f\' ORDER BY p.oid LIMIT 1',[name]);
            if(!meta.rows.length||!meta.rows[0].proretset) throw Error('RPC pagination requires SETOF');
            let sql='SELECT * FROM public.'+quote(name)+'('+argSql+')';
            const a=[...args];
            if(proxy.rangeArgs){const [lo,hi]=proxy.rangeArgs;if(!Number.isInteger(lo)||!Number.isInteger(hi)||hi<lo||hi-lo>10000)throw Error('Invalid RPC range');a.push(hi-lo+1);sql+=' LIMIT $'+a.length;a.push(lo);sql+=' OFFSET $'+a.length;}
            else {a.push(proxy.limitArg);sql+=' LIMIT $'+a.length;}
            const r=await query(sql,a);return {data:r.rows,error:null,count:null,status:200};
          }catch(e){return {data:null,error:errs(e),count:null,status:400};}
        }
        return f();
      };
      proxy.then=(resolve,reject)=>run().then(resolve,reject);
      return proxy;
    },
    async close(){if(!options.query&&pool){await pool.end();pool=null;}}
  };
}
module.exports={createClient,client:new Proxy({}, {get(_t,p){if(p==='then')return undefined;const c=createClient();const v=c[p];return typeof v==='function'?v.bind(c):v;}})};
