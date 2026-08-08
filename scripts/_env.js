'use strict';
/*
 * 로컬 실행용 환경변수 로더.
 *
 * dotenv.config() 는 .env 만 본다. 이 프로젝트의 실제 값은 Vercel CLI 가 만든
 * .env.local 에 들어 있고 .env 는 비어 있어서, 스크립트를 그냥 실행하면
 * "Supabase 환경변수 누락" 으로 죽는다.
 *
 * GitHub Actions 에서는 파일 없이 시크릿이 주입되므로 아무 파일도 못 찾아도
 * 그대로 진행한다.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
for (const f of ['.env.local', '.env']) {
  const p = path.join(root, f);
  if (fs.existsSync(p) && fs.statSync(p).size > 0) {
    require('dotenv').config({ path: p, quiet: true });
    break;
  }
}
