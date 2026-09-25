#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sqlFile = path.join(root, 'supabase', '2026-09-25-price-drop-top-candidates-rpc.sql');
const sqlRaw = fs.readFileSync(sqlFile, 'utf8');
const sql = sqlRaw
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*--[^\n]*$/gm, ' ');
const api = fs.readFileSync(path.join(root, 'api', 'init.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const verifier = fs.readFileSync(path.join(root, 'scripts', 'verify-migrations.js'), 'utf8');

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

check('defines the bounded read-only candidate RPC',
  /create\s+or\s+replace\s+function\s+public\.price_drop_top_candidates\s*\(\s*p_limit\s+integer\s+default\s+200\s*\)/i.test(sql)
  && /language\s+sql[\s\S]*?stable[\s\S]*?security\s+invoker/i.test(sql));

check('pins search_path and returns the existing 11-column API contract',
  /set\s+search_path\s*=\s*public\s*,\s*pg_temp/i.test(sql)
  && /returns\s+table\s*\(\s*product_id\s+text\s*,\s*mall\s+text\s*,\s*mall_label\s+text\s*,\s*title\s+text\s*,\s*current_price\s+integer\s*,\s*prev_price\s+integer\s*,\s*drop_amount\s+integer\s*,\s*drop_pct\s+numeric\s*,\s*is_all_time_low\s+boolean\s*,\s*link\s+text\s*,\s*image\s+text/i.test(sql));

check('preserves the last-30-day option identity and latest-two-price calculation',
  /recorded_date\s*>=\s*current_date\s*-\s*interval\s+'30 days'/i.test(sql)
  && /partition\s+by\s+ph\.product_id\s*,\s*ph\.mall\s*,\s*ph\.vendor_item_id\s+order\s+by\s+ph\.recorded_date\s+desc/i.test(sql)
  && /having\s+count\s*\(\s*\*\s*\)\s*filter\s*\(\s*where\s+rn\s*=\s*2\s*\)\s*>\s*0/i.test(sql));

check('caps and materializes top candidates before all-time minimum lookups',
  /candidates\s+as\s+materialized\s*\(/i.test(sql)
  && /order\s+by\s+drop_pct\s+desc\s+limit\s+least\s*\(\s*greatest\s*\(\s*coalesce\s*\(\s*p_limit\s*,\s*200\s*\)\s*,\s*1\s*\)\s*,\s*200\s*\)/i.test(sql)
  && /from\s+candidates\s+c[\s\S]*?cross\s+join\s+lateral\s*\([\s\S]*?min\s*\(\s*ph\.price\s*\)/i.test(sql));

check('looks up all-time minimum by the exact product, mall, and option key',
  /ph\.product_id\s*=\s*c\.product_id[\s\S]*?ph\.mall\s*=\s*c\.mall[\s\S]*?ph\.vendor_item_id\s*=\s*c\.vendor_item_id[\s\S]*?ph\.vendor_item_id\s*<>\s*'__LEGACY__'/i.test(sql));

check('grants execution only to service_role and reloads PostgREST schema',
  /revoke\s+all\s+on\s+function\s+public\.price_drop_top_candidates\s*\(integer\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i.test(sql)
  && /grant\s+execute\s+on\s+function\s+public\.price_drop_top_candidates\s*\(integer\)\s+to\s+service_role/i.test(sql)
  && /notify\s+pgrst\s*,\s*'reload schema'/i.test(sql));

check('does not alter tables, indexes, source data, or hotdeal rules',
  !/\b(?:insert|update|delete|truncate|drop|create\s+(?:table|index))\s+/i.test(sql));

check('home API uses the RPC with the same 200-row bound',
  /\.rpc\(['"]price_drop_top_candidates['"]\s*,\s*\{\s*p_limit:\s*DROP_FETCH\s*\}\)/i.test(api)
  && !/\.from\(['"]price_drop_top['"]\)/i.test(api));

check('npm test and migration verifier include the new checks',
  /test-price-drop-top-rpc\.js/.test(pkg.scripts.test)
  && pkg.scripts['test:price-drop-rpc'] === 'node scripts/test-price-drop-top-rpc.js'
  && /2026-09-25-price-drop-top-candidates-rpc\.sql/.test(verifier));

console.log('\\nprice_drop_top RPC checks: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
