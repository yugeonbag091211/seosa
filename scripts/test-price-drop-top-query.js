#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'supabase', '2026-09-25-price-drop-top-ranked-aggregation.sql');
const source = fs.readFileSync(file, 'utf8');
const sql = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*--[^\n]*$/gm, ' ');

let pass = 0;
let fail = 0;
function check(label, condition) {
  if (condition) {
    console.log('  PASS  ' + label);
    pass++;
  } else {
    console.log('  FAIL  ' + label);
    fail++;
  }
}

check('replaces only the price_drop_top view',
  /^\s*create\s+or\s+replace\s+view\s+price_drop_top\b/i.test(sql)
  && (sql.match(/\bcreate\s+or\s+replace\s+view\b/gi) || []).length === 1);

const rankedFroms = sql.match(/\bfrom\s+ranked\b/gi) || [];
check('consumes the ranked 30-day window once (prevents duplicate CTE spill)',
  rankedFroms.length === 1
  && !/\b(?:latest|prev)\s+as\s*\(/i.test(sql));

check('keeps option identity and newest-first row numbering',
  /partition\s+by\s+product_id\s*,\s*mall\s*,\s*vendor_item_id\s+order\s+by\s+recorded_date\s+desc/i.test(sql));

check('selects current and previous prices from rn 1 and rn 2',
  /max\s*\(\s*price\s*\)\s*filter\s*\(\s*where\s+rn\s*=\s*1\s*\)\s+as\s+current_price/i.test(sql)
  && /max\s*\(\s*price\s*\)\s*filter\s*\(\s*where\s+rn\s*=\s*2\s*\)\s+as\s+prev_price/i.test(sql));

check('excludes groups without a previous observation',
  /having\s+count\s*\(\s*\*\s*\)\s*filter\s*\(\s*where\s+rn\s*=\s*2\s*\)\s*>\s*0/i.test(sql));

const agg = /,\s*agg\s+as\s*\(([\s\S]*?)\)\s*select/i.exec(sql);
check('retains the all-time minimum-price aggregate',
  !!agg
  && /min\s*\(\s*price\s*\)\s+as\s+all_time_low/i.test(agg[1])
  && /vendor_item_id\s*<>\s*'__LEGACY__'/i.test(agg[1])
  && !/recorded_date/i.test(agg[1]));

check('retains the catalog inner join and full public output fields',
  /join\s+products\s+p2\s+on\s+p2\.product_id\s*=\s*lp\.product_id\s+and\s+p2\.mall\s*=\s*lp\.mall/i.test(sql)
  && /p2\.link\s*,\s*p2\.image\s*,\s*p2\.mall_label/i.test(sql));

check('does not write or delete application data',
  !/\b(?:insert|update|delete|truncate|drop)\s+/i.test(sql));

check('reloads PostgREST schema cache',
  /\bnotify\s+pgrst\s*,\s*'reload schema'/i.test(sql));

console.log('\nprice_drop_top query checks: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;