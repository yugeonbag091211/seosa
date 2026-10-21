'use strict';
/*
 * 실측 테스트 공용 — «격리된 Neon 테스트 브랜치의 트랜잭션 하나» 를 api/_supabase 자리에 끼운다.
 *
 * 운영 코드(api/·scripts/)의 실제 함수를 그대로 부르되, 모든 쓰기가 BEGIN 안에서 일어나고
 * finish() 가 ROLLBACK 한다. 각 test() 는 SAVEPOINT 로 감싸 하나가 실패해도 다음 검사가 돈다.
 * 바깥 네트워크(fetch)는 blockNetwork() 로 막을 수 있다 — 공급자 API 호출 0회를 «보장» 한다.
 */
const path = require('node:path');
const Module = require('node:module');
const pg = require('pg');

const ALLOWED_HOSTS = new Set([
  'ep-gentle-art-aoaa97v4.c-2.ap-southeast-1.aws.neon.tech',
  'ep-gentle-art-aoaa97v4-pooler.c-2.ap-southeast-1.aws.neon.tech'
]);

function assertIsolatedBranch() {
  const url = process.env.NEON_DATABASE_URL || '';
  if (!ALLOWED_HOSTS.has(new URL(url || 'postgres://x').hostname) || process.env.VERCEL_ENV !== 'preview') {
    throw new Error('격리된 Neon 테스트 브랜치(Preview)에서만 돈다');
  }
  return url;
}

function inject(rel, exportsValue) {
  const p = require.resolve(path.join(__dirname, '..', '..', rel));
  const m = new Module(p, null);
  m.filename = p; m.loaded = true; m.exports = exportsValue;
  require.cache[p] = m;
}

/** 전역 fetch 를 막는다. 시도는 기록하고 실패시킨다. */
function blockNetwork() {
  const attempts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = String(input && input.url || input);
    attempts.push(u.replace(/\?.*$/, ''));
    throw new TypeError('fetch failed (network blocked by test sandbox)');
  };
  return { attempts, restore() { globalThis.fetch = original; } };
}

async function openSandbox() {
  const url = assertIsolatedBranch();
  const { createClient, _internal } = require('../../api/_neonpg');
  const conn = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true }, types: _internal.postgrestTypes });
  await conn.connect();
  await conn.query('BEGIN');
  const sandbox = createClient({ query: (text, values) => conn.query({ text, values }) });
  inject('api/_supabase.js', sandbox);

  const counts = { passed: 0, failed: 0 };
  async function test(name, fn) {
    await conn.query('SAVEPOINT t');
    try {
      await fn();
      await conn.query('RELEASE SAVEPOINT t');
      counts.passed++;
      console.log('  PASS ' + name);
    } catch (e) {
      await conn.query('ROLLBACK TO SAVEPOINT t');
      counts.failed++;
      console.log('  FAIL ' + name + '\n       ' + (e && e.message));
    }
  }
  async function finish() {
    await conn.query('ROLLBACK');
    await conn.end();
  }
  return { sandbox, conn, test, finish, counts, url };
}

module.exports = { openSandbox, blockNetwork, assertIsolatedBranch, inject };
