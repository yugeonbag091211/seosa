'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

/*
 * 핫딜 UI — 2026-09-11 정리 이후의 계약.
 *
 * 예전 이 파일은 홈의 «오늘의 핫딜» 섹션과 /hotdeals.html(hot-view.js ·
 * hotdeals.js)을 시험했다. 그 UI는 지웠다. 사용자에게 «핫딜»은 이제 홈의
 * 가격 하락 섹션(#priceDrop, 구 «최근 가격이 내려간 상품» = 오늘의 하락)
 * 하나다. 여기서 지키는 것은 셋이다.
 *
 *   1) 옛 UI가 돌아오지 않는다 (파일 · 섹션 · 링크 · 렌더 코드)
 *   2) 이름만 바뀌었다 — 데이터 경로(/api/init → price_drop_top →
 *      plausibleDrop → todayDropConfirmed)는 그대로다
 *   3) «핫딜» 진입점이 헛클릭이 되지 않는다 (검색 중 · 데이터 없음)
 *
 * ★ 네트워크를 타지 않는다. global.fetch 를 막는 이유는 scripts/test-release.js
 *   의 SAFE 검사(유료 API 방지) 관례 때문이다 (scripts/test-product-page.js 참고).
 */
global.fetch=async url=>{throw new Error(`오프라인 테스트에서 외부 호출: ${url}`)};

const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
// 주석 속 설명(«예전에는 …였다»)이 단언을 흔들지 않게 주석을 걷어 낸 «사용자가 받는 코드»
const code=s=>s.replace(/<!--[\s\S]*?-->/g,'').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const html=read('public/index.html'), live=code(html), radar=code(read('public/radar.html'));

/* ── 1) 옛 Hot Deal UI 는 없다 ─────────────────────────────────────── */
for(const f of ['hotdeals.html','hotdeals.js','hotdeals.css','hot-view.js','hot-cards.css'])
  assert(!fs.existsSync(path.join(root,'public',f)),`public/${f} 는 지웠다`);
for(const gone of ['id="hotDeals"','hotGrid','hotCount','hot-entry','hot-card','HotView','var Hot =','getHotDeals',
  'hotdeals.html','오늘의 핫딜','핫딜 전체 보기','가격과 근거 살펴보기','지금 눈여겨볼 가격',
  "'scroll-hot'","'hot-open'","'hot-retry'","hotdeal_list_view","hotdeal_open"])
  assert(!live.includes(gone),`index.html 에 옛 핫딜 UI 흔적: ${gone}`);
assert(!radar.includes('hotdeals.html'),'레이더도 옛 핫딜 페이지로 보내지 않는다');

/* ── 2) 오늘의 하락 → 핫딜 : 이름만 바뀌었다 ───────────────────────── */
assert(!live.includes('오늘의 하락')&&!live.includes('최근 가격이 내려간 상품'),'옛 이름이 화면에 남지 않는다');
assert(/<section id="priceDrop"[^>]*aria-label="핫딜"/.test(live),'섹션 id 는 그대로, 이름은 핫딜');
assert(/<div class="sec-title">핫딜<span class="sec-count" id="dropCount"><\/span><\/div>/.test(live),'제목 «핫딜» + 개수 자리');
/*
 * ── 설명 문구 (2026-09-21) ─────────────────────────────────────────
 *
 * 예전 문구는 «SEOSA 가격 이력으로 검증한 …» 이었다. 그때는 목록에 검증
 * 통과분만 올라갔으므로 사실이었다. 이제 기본 목록이 «오늘 실제로 내려간
 * 상품» 이고 검증분은 배지로 구분되므로, 옛 문구를 그대로 두면 검증하지
 * 않은 카드까지 «SEOSA 가 검증했다» 고 말하게 된다.
 *
 * 그래서 두 가지를 같이 고정한다 — 옛 주장이 돌아오지 않는 것과,
 * 새 문구가 목록의 실제 구성을 말하는 것.
 */
assert(!live.includes('SEOSA 가격 이력으로 검증한 지금 주목할 만한 가격이에요.'),
  '«전부 검증했다»는 옛 설명이 돌아오지 않는다');
assert(live.includes('오늘(한국시간) 가격이 내려간 상품이에요.')&&live.includes('«SEOSA 검증» 배지를 붙였어요'),
  '설명은 목록의 실제 구성(하락이 기본 · 검증은 배지)을 말한다');
/*
 * ── 데이터 경로 (2026-09-20 갱신) ──────────────────────────────────
 *
 * 이 단언들은 2026-09-18 커밋(3141353 / 9c35e9d)이 홈 핫딜을 /api/init 의
 * price_drop_top 에서 실제 Hot Deal 엔진(/api/hotdeals)으로 옮긴 뒤로
 * «실패한 채 방치돼» 있었다 — 이 파일은 CI 에 걸려 있지 않아 아무도 몰랐다.
 * 지금의 계약으로 맞춘다. 옛 경로(/api/init 의 priceDrop)는 지우지 않았고
 * 다른 화면이 계속 쓰므로, 서버 쪽 판정 경로 단언은 그대로 둔다.
 */
assert(live.includes("'getHotdeals':'/api/hotdeals'"),'홈 핫딜 데이터는 /api/hotdeals (Hot Deal 엔진)');
assert(live.includes("Api.call('getHotdeals', []"),'Drop.load 는 핫딜 엔진을 부른다');
/*
 * ── 노출의 기본이 «오늘 실제 하락» 이다 (2026-09-21) ────────────────
 *
 * 예전에는 ?limit=60&sort=score 로 엔진의 «검증 통과분» 만 받았다.
 * 2026-09-21 운영 실측: 그 수가 2개였고, 같은 날 실제로 내려간 상품은
 * 24개였다 — 22개가 홈에 오르지 못했다. 이 단언이 없으면 조용히 예전
 * 구조로 되돌아가도 아무도 모른다.
 */
assert(live.includes("queryUrl = url + '?view=today-drop&limit=60'"),'홈 핫딜은 오늘 하락 목록을 받는다 (검증 통과분만이 아니다)');
assert(!live.includes("queryUrl = url + '?limit=60&sort=score'"),'검증 통과분만 받던 옛 호출이 돌아오지 않는다');
assert(live.includes('INITIAL: 5')&&live.includes('STEP: 10'),'핫딜은 기본 5개, 더보기는 10개씩');
assert(live.includes('data-act="drop-more"')&&live.includes("'drop-more': function() { Drop.more(); }"),'내부 핫딜 더보기 액션');
assert(live.includes("Drop.items.slice(0, take)"),'내부 핫딜은 visible 개수까지만 렌더한다');
assert(live.includes('Drop.fromTodayDrop'),'오늘 하락 응답을 기존 카드 모양으로 옮긴다 (UI 재사용)');
assert(!live.includes('fromHotdeal'),'부르는 곳이 없어진 옛 변환 함수는 남기지 않는다');
/* 배지 — 검증분과 하락분을 카드가 스스로 구분해 말한다. */
assert(live.includes('class="dbadge')&&live.includes('is-verified'),'카드에 검증 / 하락 배지가 있다');
assert(live.includes('.dmall .dbadge{'),'배지 스타일은 기존 판매처 줄 안에 얹는다 (카드 구조 유지)');
assert(live.includes("badge: it.badge || '오늘 가격 하락'"),'배지 문구는 서버가 정하고 화면은 기본값만 갖는다');
const td=read('api/_todaydrop.js');
assert(td.includes("BADGE_VERIFIED = 'SEOSA 검증'")&&td.includes("BADGE_TODAY = '오늘 가격 하락'"),'배지 두 문구는 한 곳에서만 정해진다');
assert(td.includes('return pct >= p || amount >= a'),'노출 관문은 5% «또는» 1,000원 (AND 가 아니다)');
const hdApi=read('api/hotdeals.js');
assert(hdApi.includes("String(q.view || '') === 'today-drop'"),'today-drop 은 기존 목록과 분리된 분기다');
assert(hdApi.includes("String(q.view || '') === 'external'"),'외부 레이더 view 는 그대로 남아 있다');
assert(live.includes('data-act="ledger-open"')&&live.includes('data-act="ledger-buy"')&&live.includes('data-act="ledger-alert"'),'카드 → 가격 추이 · 구매 · 알림 그대로');
const init=read('api/init.js');
assert(init.includes(".from('price_drop_top')")&&init.includes('.filter(plausibleDrop)')&&init.includes('todayDropConfirmed')&&init.includes('priceDrop: dropRows'),'서버의 오늘 하락 판정 경로는 그대로 (다른 화면이 쓴다)');
/*
 * 핫딜의 «정의» 가 일일 델타인지를 코드에서 고정한다 (2026-09-20 감사).
 * 이게 없으면 다시 30·90일 중앙값 순위로 돌아가도 아무도 모른다.
 */
const hd=read('api/hotdeals.js'), ch=read('scripts/collect-hotdeals.js');
assert(hd.includes("const DEFAULT_SORT = 'daily'"),'목록 기본 정렬은 어제 대비 하락률');
assert(hd.includes('expires_at.is.null,expires_at.gt.'),'만료된 딜은 목록에서 뺀다');
assert(ch.includes("DD.dailyDrop(points, { today })")&&ch.includes('if (!drop.ok)'),'수집기는 어제 대비 하락이 없으면 핫딜로 만들지 않는다');

/* ── 3) 진입점 ─────────────────────────────────────────────────────── */
assert(live.includes('<a class="nav-link hide-m" href="#priceDrop" data-act="scroll-drop">핫딜</a>'),'헤더 «핫딜» = 이 섹션');
assert(!live.includes('가격 변동</span>'),'같은 섹션을 가리키던 «가격 변동» 은 «핫딜» 로 합쳤다');
// 헤더 1 + 모바일 메뉴 1 + 히어로 CTA 1 (히어로 캐러셀 aa10ecc 에서 추가됐다).
assert.equal((live.match(/data-act="scroll-drop"/g)||[]).length,3,'헤더 1 + 메뉴 1 + 히어로 CTA 1');
assert(live.includes('data-act="scroll-drop">핫딜 보기</button>'),'모바일 메뉴 «핫딜 보기»');
assert(radar.includes('<a href="/#priceDrop">핫딜</a>'),'레이더 «핫딜» → 홈 섹션');
assert(/location\.hash === '#priceDrop'/.test(live),'/#priceDrop 로 들어오면 데이터가 온 뒤 섹션으로 옮긴다');
const vercel=JSON.parse(read('vercel.json'));
assert.deepEqual((vercel.redirects||[]).find(r=>r.source==='/hotdeals.html'),{source:'/hotdeals.html',destination:'/',permanent:false},'옛 주소는 404 대신 홈으로');

// scroll-drop 동작 — 소스에서 그대로 꺼내 가짜 환경에서 돌린다
{
  const m=html.match(/'scroll-drop':\s*(function\s*\(el, e\)\s*\{[\s\S]*?\r?\n  \}),/);
  assert(m,'scroll-drop 핸들러를 찾는다');
  const run=({searching,ready})=>{
    const log=[];
    const env={
      Nav:{closeMenu:()=>log.push('closeMenu')},
      isSearching:()=>searching,
      Search:{goHome:()=>{log.push('goHome');searching=false}},
      AppState:{ready:{drop:ready}},
      toast:msg=>log.push('toast:'+msg),
      $:id=>id==='priceDrop'?{scrollIntoView:o=>log.push('scroll:'+(o&&o.behavior))}:null
    };
    const fn=new Function(...Object.keys(env),'return '+m[1])(...Object.values(env));
    fn({}, {preventDefault:()=>log.push('preventDefault')});
    return log;
  };
  assert.deepEqual(run({searching:false,ready:true}),['preventDefault','closeMenu','scroll:smooth'],'평상시 — 부드럽게 섹션으로');
  assert.deepEqual(run({searching:true,ready:true}),['preventDefault','closeMenu','goHome','scroll:smooth'],'검색 중 — 홈으로 돌아간 뒤 섹션으로');
  const empty=run({searching:false,ready:false});
  assert(empty.some(x=>x.startsWith('toast:'))&&!empty.some(x=>x.startsWith('scroll:')),'데이터 없음 — 헛스크롤 대신 말한다');
}

/* ── 레이더가 읽는 핫딜 백엔드는 남아 있다 (UI 만 지웠다) ───────────── */
assert(fs.existsSync(path.join(root,'public/hot-theme.js')),'hot-theme.js 는 레이더가 쓴다');
assert(!!require('../api/_hotdeal.js').evaluate,'Hot Deal 엔진');
assert(!!require('../api/_hotgroup.js').groupOffers,'핫딜 군집');
assert(read('api/_radarapi.js').includes(".from('hotdeals')"),'레이더 HOT_DEAL 은 hotdeals 표를 직접 읽는다');

/* ── 4) 새 External Hotdeal Radar는 기존 핫딜을 복제하지 않는다 ─── */
assert(/<section id="externalHot"[^>]*aria-label="실시간 핫딜"/.test(live),'외부 검증 섹션');
assert(live.includes("'getExternalHotdeals':'/api/hotdeals'"),'기존 읽기 API를 재사용');
assert(live.includes('커뮤니티 발견')&&live.includes('SEOSA 검증')&&live.includes('가격 검증 전'),'검증/미검증 상태를 명확히 구분한다');
assert(live.includes('가격 이력 보기')&&live.includes('원문 보기'),'가격 이력/원문 행동');
assert(live.includes('제휴 상품 보기')&&live.includes('SEOSA에서 상품 찾기'),'외부 딜 구매 경로는 제휴 링크 또는 SEOSA 검색으로 간다');
assert(live.includes('radar-img-note')&&live.includes('참고 이미지'),'정확 매칭 전 사진은 참고 이미지로 표시한다');
assert(live.includes("it.affiliateUrl || (it.monetized ? it.productUrl : '')"),'일반 원문 URL을 제휴 상품 링크처럼 쓰지 않는다');
assert(!live.includes('var productUrl = Fmt.safeUrl(it.productUrl || it.url);'),'원문 fallback 상품 버튼 회귀 금지');
assert(live.includes('it.communityOnly === true'),'매칭 전 커뮤니티 항목도 별도 상태로 렌더한다');
assert(live.includes("it.source !== 'internal-history'"),'내부 price-drop과 중복 렌더하지 않는다');
assert(hd.includes('toCommunityListItem')&&hd.includes("row.verification_status !== 'SUSPICIOUS_PRICE'"),
  '커뮤니티 항목은 검증 완료로 위장하지 않고 의심 가격은 제외한다');
assert(hd.includes("process.env.EXTERNAL_HOTDEAL_PUBLIC !== '0'"),'외부 피드는 기본 ON, 명시적 0 kill switch 유지');
assert(live.includes('@media(max-width:560px){.radar-deals{grid-template-columns:1fr}'),'모바일 1열');

assert(live.includes("'?view=external&limit=60&minScore=60'"),'외부 카드는 전용 view 로 최대 60개를 미리 읽는다(내부 목록과 섞지 않는다)');
assert(live.includes('id="externalHotMore"')&&live.includes('data-act="external-hot-more"'),'외부 핫딜 더보기 버튼');
assert(live.includes("'external-hot-more': function() { ExternalHot.more(); }"),'외부 핫딜 더보기 액션');
assert(live.includes("ExternalHot.items.slice(0, take)"),'외부 핫딜도 기본 5개에서 10개씩 펼친다');
assert.equal((live.match(/ExternalHot.load()/g)||[]).length,1,'ExternalHot.load 는 한 번만 호출된다(init 폴백에서 중복 호출 금지)');

console.log('PASS hotdeal UI: legacy page removed, internal/external hotdeal progressive reveal 5 + 10, mobile/actions/badges');
