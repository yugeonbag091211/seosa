#!/usr/bin/env node
/**
 * vercel dev 대체 로컬 서버.
 * 한글 호스트명(박유건)에서 vercel dev가 ByteString 오류를 내므로
 * Vercel 서버리스 핸들러를 직접 로드해서 서빙한다.
 *
 * 사용법:  node scripts/dev-server.js
 * 종료:    Ctrl+C
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const http = require('http');
const url  = require('url');

// .env.local → .env 순서로 로드
const root = path.resolve(__dirname, '..');
for (const f of ['.env.local', '.env']) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    console.log(`[env] ${f} 로드됨`);
    break;
  }
}

/*
 * 로컬 서버는 운영 Supabase 를 그대로 본다.
 *
 * 여기서 쿠팡이 차단 응답을 한 번 주면 api/_coupang.js 가 coupang_api_state 에
 * 전역 차단을 기록하고, 그러면 운영 사이트의 검색까지 같이 멈춘다.
 * 로컬에서는 인스턴스 리미터만 쓰도록 기본값을 꺼둔다.
 * (일부러 전역 게이트를 시험하려면 COUPANG_DISABLE_GLOBAL_GATE=0 으로 실행)
 */
if (process.env.COUPANG_DISABLE_GLOBAL_GATE === undefined) {
  process.env.COUPANG_DISABLE_GLOBAL_GATE = '1';
}

const PORT = Number(process.env.PORT) || 3000;
const API_DIR  = path.join(root, 'api');
const PUB_DIR  = path.join(root, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function wrapRes(raw) {
  let statusCode = 200;
  const res = Object.create(raw);
  res.status = (code) => { statusCode = code; return res; };
  res.json = (data) => {
    raw.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    raw.end(JSON.stringify(data));
  };
  const origSetHeader = raw.setHeader.bind(raw);
  res.setHeader = origSetHeader;
  const origEnd = raw.end.bind(raw);
  res.end = (body) => {
    if (!raw.headersSent) raw.writeHead(statusCode);
    origEnd(body);
  };
  return res;
}

function parseReq(raw) {
  const parsed = url.parse(raw.url, true);
  raw.query = parsed.query || {};
  raw.path  = parsed.pathname;
  return raw;
}

function serveStatic(pathname, res) {
  const filePath = path.join(PUB_DIR, pathname === '/' ? 'index.html' : pathname);
  const safe = path.resolve(filePath);
  if (!safe.startsWith(PUB_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(safe, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(safe).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(pathname, req, res) {
  // /api/search → api/search.js, /api/coupang-diag → api/coupang-diag.js
  const name = pathname.replace(/^\/api\//, '').replace(/\/$/, '') || 'index';
  const file = path.join(API_DIR, name + '.js');
  if (!fs.existsSync(file) || name.startsWith('_')) {
    res.status(404).json({ error: `API not found: ${name}` });
    return;
  }
  try {
    const handler = require(file);
    if (typeof handler !== 'function') {
      res.status(500).json({ error: `${name}.js does not export a function` });
      return;
    }
    await handler(req, res);
  } catch (e) {
    console.error(`[${name}]`, e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
}

// body 파싱 (JSON POST)
function readBody(req) {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'OPTIONS') { req.body = {}; resolve(); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try { req.body = JSON.parse(raw); } catch { req.body = raw || {}; }
      resolve();
    });
    req.on('error', () => { req.body = {}; resolve(); });
  });
}

const server = http.createServer(async (rawReq, rawRes) => {
  const req = parseReq(rawReq);
  const res = wrapRes(rawRes);
  await readBody(req);

  if (req.path.startsWith('/api/')) {
    console.log(`${req.method} ${req.url}`);
    await handleApi(req.path, req, res);
  } else {
    serveStatic(req.path, rawRes);
  }
});

server.listen(PORT, () => {
  console.log(`\n  로컬 서버 시작: http://localhost:${PORT}\n`);
  console.log('  COUPANG keys :', process.env.COUPANG_ACCESS_KEY ? '설정됨' : '❌ 없음');
  console.log('  SUPABASE_URL :', process.env.SUPABASE_URL       ? '설정됨' : '❌ 없음');
  console.log('  OPENROUTER   :', process.env.OPENROUTER_API_KEY ? '설정됨' : '❌ 없음');
  console.log('');
});
