#!/usr/bin/env node
/*
 * 테이블이 초기화됐을 때 복구용.
 *
 *   node scripts/restore.js                    # 큐레이션 키워드 + products 재수집
 *   node scripts/restore.js <가격히스토리 CSV>   # 위 + price_history 재이관
 *
 * products 수집은 배포된 /api/cron 을 호출한다. 네이버/쿠팡 키는 Vercel 환경변수에만
 * 유효한 값이 들어 있어서 로컬에서 직접 수집하면 401이 난다.
 */

require('dotenv').config({ quiet: true });
const path = require('path');
const { execFileSync } = require('child_process');
const supabase = require(path.join(__dirname, '..', 'api', '_supabase.js'));

const SITE = process.env.SITE_URL || 'https://seosa-chi.vercel.app';
const JULY_KEYWORDS = ['노트북', '무선 이어폰', '스마트워치', '텀블러', '향수', '가방', '키보드', '스피커'];

(async () => {
  console.log('1) monthly_curation 7월 keywords 재적용');
  const { data: m, error: mErr } = await supabase
    .from('monthly_curation')
    .update({ keywords: JULY_KEYWORDS })
    .eq('month', 7)
    .select('keywords');
  if (mErr) throw new Error(mErr.message);
  console.log(`   -> ${m[0].keywords.length}개\n`);

  console.log(`2) products 재수집 (${SITE}/api/cron)`);
  // /api/cron은 CRON_SECRET 없이는 열리지 않는다 (쿼터 소진 방지).
  if (!process.env.CRON_SECRET) {
    throw new Error('CRON_SECRET 환경변수가 필요합니다. Vercel에 설정한 값과 같게 .env에 넣어주세요.');
  }
  const r = await fetch(`${SITE}/api/cron`, {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }
  });
  const cron = await r.json();
  if (!r.ok) throw new Error(`/api/cron ${r.status}: ${cron.error || ''}`);
  console.log(`   -> ${cron.totalSaved}건 저장, ${cron.elapsedMs}ms`);
  (cron.results || []).filter(x => x.errors.length)
    .forEach(x => console.log(`   경고 ${x.keyword}: ${x.errors[0].slice(0, 70)}`));
  console.log('');

  const csv = process.argv[2];
  if (csv) {
    console.log('3) price_history 재이관');
    execFileSync(process.execPath, [path.join(__dirname, 'import-history.js'), csv, '--commit'],
      { stdio: 'inherit' });
    console.log('');
  } else {
    console.log('3) price_history 이관 건너뜀 (CSV 경로를 인자로 주면 함께 복구)\n');
  }

  for (const t of ['products', 'price_history']) {
    const { count } = await supabase.from(t).select('*', { count: 'exact', head: true });
    console.log(`${t.padEnd(15)} ${count}행`);
  }
})().catch(e => { console.error('오류: ' + e.message); process.exit(1); });
