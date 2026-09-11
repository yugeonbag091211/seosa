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
for(const gone of ['id="hotDeals"','hotGrid','hotCount','hot-entry','hot-card','HotView','Hot.load','getHotDeals',
  '/api/hotdeals','hotdeals.html','오늘의 핫딜','핫딜 전체 보기','가격과 근거 살펴보기','지금 눈여겨볼 가격',
  "'scroll-hot'","'hot-open'","'hot-retry'","hotdeal_list_view","hotdeal_open"])
  assert(!live.includes(gone),`index.html 에 옛 핫딜 UI 흔적: ${gone}`);
assert(!radar.includes('hotdeals.html'),'레이더도 옛 핫딜 페이지로 보내지 않는다');

/* ── 2) 오늘의 하락 → 핫딜 : 이름만 바뀌었다 ───────────────────────── */
assert(!live.includes('오늘의 하락')&&!live.includes('최근 가격이 내려간 상품'),'옛 이름이 화면에 남지 않는다');
assert(/<section id="priceDrop"[^>]*aria-label="핫딜"/.test(live),'섹션 id 는 그대로, 이름은 핫딜');
assert(/<div class="sec-title">핫딜<span class="sec-count" id="dropCount"><\/span><\/div>/.test(live),'제목 «핫딜» + 개수 자리');
assert(live.includes('오늘 확인한 가격이 직전 기록보다 내려간 상품이에요.'),'설명은 판정(todayDropConfirmed)과 같은 말을 한다');
// 데이터 경로 — 새 핫딜 알고리즘이 아니다
assert(live.includes("'getPriceDropTop':'/api/init'"),'데이터는 /api/init');
assert(live.includes("Api.call('getPriceDropTop', [8], Drop.show"),'Drop.load 그대로');
assert(live.includes('Drop.show(d.priceDrop)'),'부팅 경로 그대로');
assert(live.includes('data-act="ledger-open"')&&live.includes('data-act="ledger-buy"')&&live.includes('data-act="ledger-alert"'),'카드 → 가격 추이 · 구매 · 알림 그대로');
const init=read('api/init.js');
assert(init.includes(".from('price_drop_top')")&&init.includes('.filter(plausibleDrop)')&&init.includes('todayDropConfirmed')&&init.includes('priceDrop: dropRows'),'서버 판정 경로 그대로');

/* ── 3) 진입점 ─────────────────────────────────────────────────────── */
assert(live.includes('<a class="nav-link hide-m" href="#priceDrop" data-act="scroll-drop">핫딜</a>'),'헤더 «핫딜» = 이 섹션');
assert(!live.includes('가격 변동</span>'),'같은 섹션을 가리키던 «가격 변동» 은 «핫딜» 로 합쳤다');
assert.equal((live.match(/data-act="scroll-drop"/g)||[]).length,2,'헤더 1 + 메뉴 1');
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

console.log('PASS hotdeal UI: old Hot Deal UI removed, 오늘의 하락 → 핫딜 label, price-drop data path unchanged, entry points (search/empty/hash), radar link, redirect');
