const supabase = require('./_supabase');

// price_history 쓰기 권한 + 컬럼 구조 진단용 임시 엔드포인트
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  // 1. price_history 컬럼 목록 확인 (빈 select)
  const { data: sample, error: sErr } = await supabase
    .from('price_history')
    .select('*')
    .limit(1);
  results.columns = sample && sample[0] ? Object.keys(sample[0]) : (sErr ? `읽기 오류: ${sErr.message}` : []);

  // 2. 테스트 행 INSERT (recorded_at 포함)
  const NOW = new Date().toISOString();
  const TODAY = NOW.slice(0, 10);
  const testRowFull = {
    product_id: '__DBTEST__',
    mall: '__DBTEST__',
    title: '__DBTEST__',
    price: 1,
    link: '',
    recorded_at: NOW,
    recorded_date: TODAY
  };
  const { error: e1 } = await supabase
    .from('price_history')
    .upsert([testRowFull], { onConflict: 'product_id,mall,recorded_date' });
  results.upsert_with_recorded_at = e1 ? `FAIL: ${e1.message}` : 'OK';

  // 3. 테스트 행 INSERT (recorded_at 없음)
  const testRowNoAt = {
    product_id: '__DBTEST2__',
    mall: '__DBTEST2__',
    title: '__DBTEST2__',
    price: 1,
    link: '',
    recorded_date: TODAY
  };
  const { error: e2 } = await supabase
    .from('price_history')
    .upsert([testRowNoAt], { onConflict: 'product_id,mall,recorded_date' });
  results.upsert_without_recorded_at = e2 ? `FAIL: ${e2.message}` : 'OK';

  // 4. ignoreDuplicates: false 버전
  const { error: e3 } = await supabase
    .from('price_history')
    .upsert([testRowFull], { onConflict: 'product_id,mall,recorded_date', ignoreDuplicates: false });
  results.upsert_ignoreDuplicates_false = e3 ? `FAIL: ${e3.message}` : 'OK';

  // 5. 테스트 행 정리
  const { error: delErr } = await supabase
    .from('price_history')
    .delete()
    .in('product_id', ['__DBTEST__', '__DBTEST2__']);
  results.cleanup = delErr ? `FAIL: ${delErr.message}` : 'OK';

  // 6. NAVER API 환경변수 확인 (실제 값 노출 없이)
  results.env = {
    NAVER_CLIENT_ID: !!process.env.NAVER_CLIENT_ID ? '설정됨' : '없음',
    NAVER_CLIENT_SECRET: !!process.env.NAVER_CLIENT_SECRET ? '설정됨' : '없음',
    COUPANG_ACCESS_KEY: !!process.env.COUPANG_ACCESS_KEY ? '설정됨' : '없음',
    COUPANG_SECRET_KEY: !!process.env.COUPANG_SECRET_KEY ? '설정됨' : '없음',
    SUPABASE_URL: !!process.env.SUPABASE_URL ? '설정됨' : '없음',
    SUPABASE_SECRET_KEY: !!process.env.SUPABASE_SECRET_KEY ? '설정됨' : '없음'
  };

  res.json(results);
};
