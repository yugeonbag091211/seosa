#!/usr/bin/env node
'use strict';
// Read-only migration inventory. Deliberately does not read .env files or call a database.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '../..');
function exists(rel) { return fs.existsSync(path.join(root, rel)); }
function available(cmd) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  try { return cp.spawnSync(lookup, [cmd], { stdio: 'ignore', timeout: 2000 }).status === 0; }
  catch (_) { return false; }
}
const apiDir = path.join(root, 'api');
const files = fs.readdirSync(apiDir).filter(n => n.endsWith('.js'));
const dependencies = [];
for (const name of files) {
  const source = fs.readFileSync(path.join(apiDir, name), 'utf8');
  if (source.includes('_supabase') || /supabase\.(?:from|rpc|storage|auth)\s*\(/.test(source)) dependencies.push(name);
}
const report = {
  project: 'seosa', mode: 'DRY_RUN_ONLY', noRemoteCalls: true,
  neonConfigPresent: exists('neon.ts'),
  neonEnvFilePresent: exists('.env.local'),
  neonConnectionEnvironmentPresent: Boolean(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL),
  sourceDatabaseEnvironmentPresent: ['PGHOST','PGDATABASE','PGUSER'].every(k => Boolean(process.env[k])),
  sourceDatabasePasswordEnvironmentPresent: Boolean(process.env.PGPASSWORD),
  r2ConfigurationPresent: ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'].every(k => Boolean(process.env[k])),
  pgDumpPresent: available('pg_dump'),
  pgRestorePresent: available('pg_restore'),
  supabaseDependentApiFiles: dependencies.length,
  sampleSupabaseDependentApiFiles: dependencies.slice(0, 18),
  sourceDataExported: false,
  sourceRowsValidated: false,
  neonApplicationWired: false,
  r2BucketConnected: false,
  productionSwitched: false
};
console.log(JSON.stringify(report, null, 2));
console.log('NEXT: obtain source PostgreSQL connection in a LOCAL terminal (never paste passwords into chat), install pg_dump >= 17, and export only after confirming a private backup path.');
console.log('Do not remove Supabase or modify Vercel Production until parity checks pass.');
