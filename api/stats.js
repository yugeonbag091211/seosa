const supabase = require('./_supabase');
const { applyCors, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
/*
 * 최소 사용자 계측이 이 엔드포인트에 얹혀 있다.
 *
 * ★ 왜 여기인가 — Vercel Hobby 는 서버리스 함수 12개가 상한이고 현재 11개다.
 *   계측은 인증 없이 받아야 하는데(비로그인 방문자가 대부분이다), 그 성질을
 *   가진 엔드포인트는 이미 여기 하나뿐이다. 레이트리미터·CORS·no-store 가
 *   전부 갖춰져 있어 새로 만들 것이 없다.
 */
const analytics = require('./_analytics');

const MAX_KEYWORD_LEN = 80;

/**
 * 집계에 넣어도 되는 검색어인가.
 *
 * 이 엔드포인트는 인증 없이 DB에 쓰는 유일한 곳이고, 여기 쌓인 값이 그대로
 * 홈 화면 "실시간 인기 검색어"와 자동완성에 노출된다. 출력은 이스케이프하고
 * 있어서 XSS는 안 되지만, 광고 문구나 URL을 밀어 넣어 첫 화면을 도배하는 것은
 * 막을 게 없었다. 검색어처럼 생기지 않은 값은 세지 않는다.
 */
function countable(kw) {
  if (!kw || kw.length > MAX_KEYWORD_LEN) return false;
  if (/https?:\/\/|www\.|\.(com|net|kr|co)\b/i.test(kw)) return false;   // 링크 홍보
  // \p{C} = 제어·서식·미할당 문자. 소스에 제어문자를 직접 넣으면 grep이 이 파일을
  // 바이너리로 취급하므로 api/ai.js와 같은 방식으로 쓴다.
  if (/\p{C}|[<>]/u.test(kw)) return false;
  return true;
}

/**
 * select 후 update 하는 방식은 같은 키워드가 동시에 검색되면 카운트가 유실된다.
 * increment_search_stat RPC(단일 statement)를 우선 쓰고,
 * 아직 supabase/schema.sql을 실행하지 않은 환경에서는 예전 방식으로 폴백한다.
 */
async function incrementFallback(keyword) {
  const { data: row, error: selErr } = await supabase
    .from('search_stats')
    .select('id, count')
    .eq('keyword', keyword)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);

  if (row) {
    const { error } = await supabase
      .from('search_stats')
      .update({ count: (row.count || 0) + 1 })
      .eq('id', row.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('search_stats').insert({ keyword, count: 1 });
    if (error) throw new Error(error.message);
  }
}

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;
  noStore(res);   // 집계는 캐시 대상이 아니다

  // 인증 없이 DB에 쓰는 유일한 엔드포인트다. 열어두면 한 대에서 수만 번을 눌러
  // 인기 검색어를 원하는 문구로 도배할 수 있다. 사람이 검색하는 속도로 제한한다.
  if (!guard(req, res, { name: 'stats', limit: 30, windowMs: 60 * 1000 })) return;

  /*
   * ── 지표 조회 (관리자) ────────────────────────────────────────
   *
   * CRON_SECRET 뒤에 둔다. 방문자·매출 지표는 공개할 값이 아니고, 이미
   * /api/cron 이 같은 비밀로 보호되고 있어 관리자용 관문이 하나로 유지된다.
   *
   * secret 이 없으면 열지 않고 막는다(fail closed) — api/cron.js 와 같은 규칙.
   */
  if (req.query && req.query.report === '1') {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.error('[stats] CRON_SECRET 미설정 — 지표 조회를 열지 않습니다.');
      return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되지 않았습니다.' });
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      return res.status(401).json({ error: '인증 실패' });
    }
    return res.json(await analytics.report());
  }

  /*
   * ── 계측 기록 ─────────────────────────────────────────────────
   *
   * 검색어 집계와 별개의 경로다. 프론트는 페이지 진입 시 event=visit,
   * 상품 카드를 누를 때 event=click 을 보낸다.
   *
   * 실패해도 200 으로 답한다. 계측이 안 됐다고 사용자 화면에 오류를 띄울
   * 이유가 없다 — 응답의 counted 로만 알린다.
   */
  const event = String((req.query && req.query.event) || '').trim().toLowerCase();
  if (event) {
    if (event === 'visit') {
      const r = await analytics.trackVisit((req.query && req.query.vid) || '');
      return res.json({ ok: true, counted: r.ok });
    }
    const r = await analytics.bump(event);
    return res.json({ ok: true, counted: r.ok });
  }

  const keyword = ((req.query && req.query.keyword) || '').trim().slice(0, MAX_KEYWORD_LEN);
  if (!keyword) return res.status(400).json({ error: '키워드 없음' });

  // 집계하지 않을 값이어도 프론트 검색 흐름은 막지 않는다 (ok로 응답하고 세지만 않는다).
  if (!countable(keyword)) return res.json({ ok: true, counted: false });

  try {
    const { error: rpcErr } = await supabase.rpc('increment_search_stat', { kw: keyword });
    if (rpcErr) {
      // 함수가 아직 없는 환경(스키마 미적용)만 폴백한다. 그 외 오류는 그대로 올린다.
      if (!/function|schema cache|does not exist/i.test(rpcErr.message)) {
        throw new Error(rpcErr.message);
      }
      await incrementFallback(keyword);
    }

    /*
     * 검색 횟수는 여기서 센다 — 프론트가 요청을 하나 더 보내지 않게.
     *
     * search_stats 는 "어떤 검색어가 인기인가" 를 키워드별로 누적할 뿐,
     * "오늘 검색이 몇 번 있었나" 를 답하지 못한다 (날짜가 없다). 그래서
     * 날짜별 카운터를 따로 올린다. 실패해도 검색 흐름은 건드리지 않는다.
     */
    await analytics.bump('search');

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
