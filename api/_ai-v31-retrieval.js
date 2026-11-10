'use strict';
// v3.1/v3.2 bounded read-only DB probe planner.
// Uses product taxonomy, literal user clues, and verified product identity.
// Never learns user intent from seller listing text or model-generated brands.
const {searchAnchors}=require('./_ai-v31-taxonomy');
const safe=s=>String(s||'').normalize('NFKC').replace(/[^0-9a-zA-Z가-힣+\s-]/g,' ').replace(/\s+/g,' ').trim().slice(0,80);
const flat=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g,'');
const key=spec=>spec.map(f=>f.join(':')).join('|');

// v3.2 brand lexicon lives in _ai-v32-brands (shared, dependency-free).
const {BRANDS,LINES,aliasRegex,aliasesFor}=require('./_ai-v32-brands');
const {requestedIdentity}=require('./_ai-v3-identity');
const REJECTS=/^\s*(?:은|는|이|가|을|를)?\s*(?:제외|말고|빼고|아닌|없이|싫)/;
const HOST_AFTER=/^[\s0-9a-z가-힣.]{0,12}?(?:용(?![a-z가-힣])|전용|호환|연결|에\s*(?:쓸|쓰는|맞는|연결|꽂))/i;
// Brands the USER named (aliases for the category), excluding brands named
// only to reject them ("삼성 제외") or as a host device ("아이폰 호환",
// "맥북용"). A product-line alias counts only in its own category.
function brandsFromUser(text,category='') {
  const s=String(text||'').normalize('NFKC');
  for(const entry of BRANDS){
    const company=entry[1];
    const usable=category?aliasesFor(entry,category):[...company,...Object.keys(entry[2]||{})];
    for(const alias of usable){
      const g=new RegExp(aliasRegex(alias).source,'gi');
      let m,named=false;
      while((m=g.exec(s))!==null){
        const after=s.slice(m.index+m[0].length,m.index+m[0].length+18);
        if(REJECTS.test(after))continue;
        if(HOST_AFTER.test(after)&&!company.includes(alias))continue;
        named=true;break;
      }
      if(named)return category?aliasesFor(entry,category):[...company];
    }
  }
  return [];
}
// A title carries the brand when one of its aliases appears NOT as a host
// device ("ARZOPA ... 삼성 DeX 모드 지원" is not a Samsung monitor).
function brandMatches(title,requestText,category='') {
  const brands=brandsFromUser(requestText,category);
  if(!brands.length)return true;
  const t=String(title||'').normalize('NFKC');
  return brands.some(alias=>{
    const g=new RegExp(aliasRegex(alias).source,'gi');
    let m;
    while((m=g.exec(t))!==null){
      const after=t.slice(m.index+m[0].length,m.index+m[0].length+14);
      // '제논 입문용 일렉기타' describes the branded instrument, not an
      // accessory compatible with the brand. A generic '...용' detector
      // otherwise mistakes the suffix of '입문용' for a host-device marker.
      if(/^\s*(?:입문|연습|학생|초보(?:자)?)\s*용(?:\s|$)/i.test(after))return true;
      if(!/^[\s0-9a-z가-힣.]{0,10}?(?:호환|전용|용(?![a-z가-힣])|지원|대응)/i.test(after))return true;
    }
    return false;
  });
}
// Bilingual model words: seller titles write "플립6" or "FLIP 6". Longest
// keys first so "에어팟" is not turned into "air팟".
const TRANSLIT=[['사운드링크','soundlink'],['마이패스포트','mypassport'],['슈퍼라이트','superlight'],['엘리먼츠','elements'],
  ['익스팬션','expansion'],['울트라와이드','ultrawide'],['울트라기어','ultragear'],['스탠모어','stanmore'],
  ['엠버튼','emberton'],['원터치','onetouch'],['에어팟','airpods'],['플립','flip'],['액톤','acton'],['차지','charge'],
  ['클립','clip'],['플렉스','flex'],['쉴드','shield'],['실드','shield'],['캔비오','canvio'],['오리진','origin'],
  ['디텍트','detect'],['클래식','classic'],['울트라','ultra'],['플러스','plus'],['프로','pro'],['맥스','max'],['미니','mini'],
  ['에어','air'],['엣지','edge'],['버즈','buds'],['워치','watch'],['시리즈','series'],['레드미','redmi'],['포코','poco'],
  ['큐레보','qrevo'],['마스터','master'],['액티브','active'],['라이트','lite']];
function canonModel(s){
  let f=flat(s);
  for(const [ko,en] of TRANSLIT)f=f.split(ko).join(en);
  return f;
}
// Words that do not identify a model (feature/spec/category/request words).
const NOT_MODEL=new Set(['anc','enc','usb','usbc','wifi','fhd','qhd','uhd','hdd','ssd','tws','dpi','rgb','oled','lcd','ips',
  'gps','led','hdmi','ram','gb','tb','mm','cm','hz','pc','tv','bt','ai','ok','vs','lte','5g','4k','2k','pd','ps5','ps4',
  'aux','type','c','wfhd','ipx','mic','nfc','sd','hepa','bldc','qled','va','uv','dac','iot','app','esim','gaming']);
const VARIANT_WORDS=['active','lite','pro','plus','ultra','max','mini','fe','edge','classic','se','air','shield','slim'];
const FAMILY_WORD=/(?:iphone|ipad|galaxy|airpods|macbook|buds|아이폰|아이패드|갤럭시|맥북|애플\s*워치|applewatch)/i;
// Model phrases the user typed: "WF-C700N", "T7 Shield", "Flip 6", "V12",
// "MX Keys S", "G Pro X Superlight 2", "워치 5", "액톤 3". Consecutive
// Latin/model tokens form ONE phrase. Identity families (iPhone, Galaxy...)
// are left to the identity module. Each clue: { token, raw }.
function modelClues(text){
  const s=safe(text).toLowerCase();
  if(requestedIdentity(s).family)return [];
  const brandWords=new Set(BRANDS.flatMap(([,c,l])=>[...c,...Object.keys(l||{})].map(x=>flat(x))));
  const PARTICLE='(?:을|를|이|가|은|는|에|에서|로|으로|도|만|과|와|의|랑)';
  const words=s.split(/\s+/).filter(Boolean).map(w=>w.replace(/^-+|-+$/g,'')
    .replace(new RegExp('(\\d)'+PARTICLE+'$'),'$1')
    .replace(new RegExp('^([a-z][a-z0-9+-]*)'+PARTICLE+'$'),'$1'));
  const out=[];let run=[];
  const unit=w=>/^\d+(?:\.\d+)?(?:gb|tb|mm|cm|hz|w|인치|기가|테라|만원|원|형|개|세대|시간|평)$/.test(w);
  const flush=()=>{
    if(run.length){
      const token=canonModel(run.join(''));
      const meaningful=/\d/.test(token)||token.replace(/[^a-z]/g,'').length>=4;
      if(meaningful&&!FAMILY_WORD.test(run.join(' ')))out.push({token,raw:run.join(' ')});
    }
    run=[];
  };
  for(const w of words){
    const latin=/^[a-z0-9+-]+$/.test(w)&&/[a-z]/.test(w)&&!NOT_MODEL.has(flat(w))&&!brandWords.has(flat(w))&&!unit(w);
    const digitAfter=/^\d{1,2}[a-z]?$/.test(w)&&run.length>0;
    const koModel=TRANSLIT.some(([ko])=>w.startsWith(ko))&&!brandWords.has(flat(w));
    if(latin||digitAfter||koModel)run.push(w);
    else flush();
  }
  flush();
  const seen=new Set();
  return out.filter(c=>{if(seen.has(c.token))return false;seen.add(c.token);return true;}).slice(0,4);
}
// Product lines named by the user ("비보북", "오디세이", "블루스카이").
function linesFromUser(text){
  const s=String(text||'').normalize('NFKC');
  return LINES.filter(([ko,en])=>[ko,en].some(a=>{
    const m=aliasRegex(a).exec(s);
    return m&&!REJECTS.test(s.slice(m.index+m[0].length,m.index+m[0].length+10));
  }));
}
// Does a listing carry every model phrase / product line the user named,
// without an extra variant suffix the user did not ask for? "워치5 액티브" ≠
// "워치 5", "SUPERLIGHT 2c" ≠ "Superlight 2", "MX Master 3S" ≠ "MX Master 3".
function modelEvidence(title,userText){
  const clues=modelClues(userText),lines=linesFromUser(userText);
  if(!clues.length&&!lines.length)return {ok:true,checked:0};
  const t=canonModel(title),u=canonModel(userText),ft=flat(title);
  for(const [ko,en] of lines)if(!ft.includes(flat(ko))&&!ft.includes(flat(en)))return {ok:false,missing:ko};
  for(const {token} of clues){
    const at=t.indexOf(token);
    if(at<0)return {ok:false,missing:token};
    if(!/\d$/.test(token))continue;
    const tail=t.slice(at+token.length,at+token.length+12);
    // "액티브 노이즈 캔슬링" is a feature, not the "Active" model variant.
    const extra=VARIANT_WORDS.find(v=>tail.startsWith(v)&&!u.includes(token+v)&&
      !(v==='active'&&/^active(?:노이즈|noise)/.test(tail)));
    if(extra)return {ok:false,variant:extra,token};
    // a single letter glued to the number: "2c", "3s", "16e"
    // (not followed by a digit: "air11"+"m4" is the next code, not a suffix)
    if(/^[a-z](?![a-z0-9])/.test(tail)&&!u.includes(token+tail[0]))return {ok:false,variant:tail[0],token};
  }
  return {ok:true,checked:clues.length+lines.length};
}
function deviceAnchors(category,identity={}) {
  if(identity?.family==='ipad')return ['아이패드','iPad'];
  if(identity?.family==='galaxytab')return ['갤럭시탭','Galaxy Tab'];
  if(identity?.family==='airpods')return ['에어팟','AirPods'];
  if(identity?.family==='galaxybuds')return ['버즈','Galaxy Buds'];
  if(identity?.family==='iphone')return ['아이폰','iPhone'];
  if(identity?.family==='galaxys')return ['갤럭시 S','Galaxy S'];
  if(identity?.family==='macbook')return ['맥북','MacBook'];
  if(identity?.family==='galaxywatch')return ['갤럭시 워치','Galaxy Watch'];
  if(identity?.family==='applewatch')return ['애플워치','Apple Watch'];
  if(identity?.family==='galaxybook')return ['갤럭시북','Galaxy Book'];
  if(category==='헤드폰')return ['헤드폰','헤드셋'];
  if(category==='이어폰')return ['이어폰','이어버드','버즈'];
  if(category==='외장하드')return ['외장하드','외장 SSD','외장 HDD'];
  if(category==='스마트폰')return ['자급제','스마트폰','공기계'];
  if(category==='시계')return ['스마트워치','워치','시계'];
  if(category==='기타')return ['일렉기타','통기타','클래식 기타'];
  return searchAnchors(category).filter(s=>s.length>=2).slice(0,3);
}
const FEATURE_PROBES=[
  [['스피커'],/(?:\btv\b|티비)/i,['TV','HDMI']],
  [['공기청정기','청소기'],/(?:hepa|헤파)/i,['헤파','HEPA']],
  [['공기청정기'],/(?:앱|어플|스마트폰\s*(?:연동|연결)|와이파이|iot)/i,['IoT','스마트']],
  [['키보드'],/기계식/,['기계식']],
  [['청소기'],/스틱/,['스틱']],
  [['청소기'],/유선/,['유선']],
  [['헤드폰','이어폰','마우스','키보드','스피커'],/유선/,['유선']],
  [['모니터'],/(?:\bfhd\b)/i,['FHD']],[['모니터'],/(?:\bqhd\b)/i,['QHD']],[['모니터'],/(?:\b4k\b|\buhd\b)/i,['4K','UHD']],
  [['모니터'],/(\d{3})\s*hz/i,['Hz']],
  [['기타'],/(?:미니|어린이|아동|키즈)/,['미니']]
];
const VARIANT_KO={edge:['엣지','Edge'],plus:['플러스','Plus'],ultra:['울트라','Ultra'],pro:['프로','Pro'],
  'pro-max':['프로 맥스','Pro Max'],fe:['FE'],classic:['클래식','Classic'],mini:['미니','mini'],air:['에어','Air'],
  e:['e'],se:['SE'],'fe-plus':['FE+','FE 플러스'],pro360:['프로360','Pro 360']};
function identityProbes(identity={}){
  const f=identity&&identity.family,s=identity&&identity.series;
  if(!f||!s)return [];
  const v=identity.variant&&VARIANT_KO[identity.variant]?VARIANT_KO[identity.variant]:[null];
  const base={galaxys:[['갤럭시','S'+s],['Galaxy','S'+s],['S'+s,'자급제']],
    galaxytab:[['갤럭시탭','S'+s],['Galaxy Tab','S'+s]],
    galaxywatch:[['갤럭시','워치'+s],['Galaxy Watch'+s]],applewatch:[['애플워치',s],['Apple Watch',s]],
    galaxybook:[['갤럭시북'+s],['Galaxy Book'+s]],iphone:[['아이폰',s],['iPhone',s]],
    airpods:[['에어팟',s]],galaxybuds:[['버즈'+s],['Buds'+s]]}[f]||[];
  const out=[];
  // A BASE model request ("버즈3 기본형", "갤럭시 S25") excludes the variant
  // words in SQL ('!' = NOT ILIKE), so Pro/FE/Ultra listings cannot fill the
  // 40-row page before the base model is reached.
  const notVariants=!identity.variant?(BASE_EXCLUDES[f]||[]).map(w=>['title','!'+w]):[];
  for(const words of base.slice(0,2)){
    for(const variant of v.slice(0,2)){
      out.push([...words,...(variant?[variant]:[])].map(w=>['title',w]).concat(notVariants));
    }
  }
  if(base[2])out.push(base[2].map(w=>['title',w]).concat(notVariants));
  return out.slice(0,4);
}
const BASE_EXCLUDES={galaxybuds:['프로','pro','fe','라이브'],galaxys:['울트라','ultra','엣지','edge'],
  iphone:['프로','pro','플러스','plus'],airpods:['프로','pro','맥스'],galaxytab:['울트라','ultra','플러스'],
  galaxywatch:['클래식','classic','울트라','ultra'],galaxybook:['프로','pro','360','엣지']};
function deriveClues(query,userText,identity,category='') {
  const text=safe([query,userText].join(' '));
  const model=[];
  if(identity?.chip)model.push(String(identity.chip));
  const known=[...text.matchAll(/\b(?:WH-[A-Z0-9-]{4,}|WF-[A-Z0-9-]{4,}|T\d{1,2}|MX\s*MASTER|S\d{1,2}\s*FE\+?|V\d{1,2}|G\d{3})\b/gi)];
  for(const m of known)if(!model.some(x=>x.toLowerCase()===m[0].toLowerCase()))model.push(m[0]);
  const size=identity?.screenInches?String(identity.screenInches):'';
  const store=identity?.storageGb?String(identity.storageGb):'';
  const storeAlternatives=store?Number(store)%1024===0?
    [String(Number(store)/1024)+'TB',String(Number(store)/1024)+'테라',store+'GB']:
    [store+'GB',store+'기가']: [];
  const wantsNoise=/(?:노이즈\s*캔슬링|ANC|노이즈캔슬링)/i.test(text);
  return {models:model.slice(0,2),size,storeAlternatives,brands:brandsFromUser(text,category),wantsNoise};
}
function buildProbes({query='',category='',userText='',identity={},minPrice,maxPrice}={}) {
  if(!category)return [];
  const clues=deriveClues(query,userText,identity,category);
  const types=deviceAnchors(category,identity),sets=[],seen=new Set();
  function push(spec){
    // keep the '!' (NOT ILIKE) marker that safe() would strip
    const filters=spec.map(([c,v])=>[c,String(v).startsWith('!')?'!'+safe(String(v).slice(1)):safe(v)])
      .filter(([,v])=>v.replace(/^!/,'').length>=1);
    if(!filters.some(([,v])=>!v.startsWith('!')))return;
    if(!filters.length)return;
    const k=key(filters);
    if(seen.has(k))return;
    seen.add(k);sets.push(filters);
  }
  // Bass guitars are not indexed under the usual electric/acoustic guitar
  // anchors. Probe the user-requested instrument and brand before a broad
  // 40-row page; the normal SKU/type/price guards still apply.
  if(category==='기타' && /(?:베이스\s*기타|bass\s*guitar)/i.test(userText||query)) {
    const requestedBrand=clues.brands[0]||'';
    for(const term of ['베이스','bass']) {
      if(requestedBrand)push([['title',requestedBrand],['title',term]]);
      push([['title',term],['title','기타']]);
    }
  }
  // Device-compatible accessories: "아이패드용 블루투스 키보드"
  // needs a two- or three-facet lookup, not the first 40 generic keyboards.
  // The device noun is a compatibility target, not the item being sold.
  if(category==='키보드' && /(?:아이패드|ipad)/i.test(userText+' '+query)) {
    for(const device of ['아이패드','iPad']) {
      if(/(?:블루투스|bluetooth)/i.test(userText+' '+query))
        push([['title',device],['title','블루투스'],['title','키보드']]);
      push([['title',device],['title','키보드']]);
    }
  }
  // v3.2: a model code the user typed is the strongest clue. Probe it with
  // the brand and alone (codes are rare strings), before broad category hits.
  const brand=clues.brands[0]||'';
  for(const {raw} of modelClues(userText||query).slice(0,2)){
    if(raw.replace(/[\s-]/g,'').length>=2){
      if(brand)push([['title',brand],['title',raw]]);
      push([['title',raw],['title',types[0]||category]]);
      if(/\d/.test(raw)&&raw.replace(/[\s-]/g,'').length>=4)push([['title',raw]]);
    }
  }
  // A full model number or named brand is stronger than a broad category hit.
  for(const model of clues.models) {
    for(const categoryAnchor of types.slice(0,2))push([['title',categoryAnchor],['title',model]]);
    if(clues.storeAlternatives.length)
      for(const storage of clues.storeAlternatives.slice(0,2))
        push([['title',model],['title',storage]]);
  }
  // Family + series (+ variant word): "갤럭시 S25 엣지", "갤럭시워치7",
  // "아이폰 16 프로". Tokens are AND-ed, so spacing and order do not matter.
  for(const spec of identityProbes(identity))push(spec);
  if(clues.size)for(const categoryAnchor of types.slice(0,2)) {
    if(clues.models.length)push([['title',categoryAnchor],['title',clues.models[0]],['title',clues.size]]);
    else push([['title',categoryAnchor],['title',clues.size]]);
  }
  if(clues.storeAlternatives.length){
    for(const categoryAnchor of types.slice(0,2))
      push([['title',categoryAnchor],['title',clues.storeAlternatives[0]]]);
  }
  // Bare "external SSD" with only a budget is not a model-specific request.
  // Facet several *candidate* capacities to avoid a 40-row accessory page;
  // never treat these as user-imposed capacity restrictions.
  if(category==='외장하드' && /(?:외장\s*ssd|포터블\s*ssd|portable\s*ssd)/i.test(userText+' '+query) &&
    !clues.storeAlternatives.length && !clues.models.length) {
    for(const anchor of ['외장SSD','외장 SSD']) {
      for(const capacity of ['480GB','512GB','256GB'])
        push([['title',anchor],['title',capacity]]);
    }
  }
  // Brand × category: every alias the user's brand is written with.
  for(const alias of clues.brands.slice(0,3))
    for(const categoryAnchor of types.slice(0,2))
      push([['title',alias],['title',categoryAnchor]]);
  // Left-handed wireless mouse requests can be fulfilled by ambidextrous
  // (양손잡이/좌우대칭) devices. Search those *seller-stated* ergonomic aliases
  // before the broad 40-row mouse page, which otherwise buries eligible M170.
  // Probes expand retrieval only: the user-grounded validator still checks
  // wireless support, handedness, budget and variant price independently.
  if(category==='마우스' && /(?:왼손(?:잡이|용)?|left[ -]?hand(?:ed)?)/i.test(userText+' '+query)) {
    for(const ergonomic of ['왼손','양손잡이','좌우대칭','양손','ambidextrous'])
      push([['title','마우스'],['title',ergonomic]]);
  }
  // v3.2: a feature the user requires is probed together with the category
  // so the first 40 rows are not all listings that cannot show it.
  for(const [cats,asked,terms] of FEATURE_PROBES){
    if(!cats.includes(category)||!asked.test(userText+' '+query))continue;
    for(const term of terms.slice(0,2))push([['title',types[0]||category],['title',term]]);
  }
  if(clues.wantsNoise&&category==='헤드폰') {
    push([['title','헤드폰'],['title','노이즈']]);
    push([['title','헤드폰'],['title','ANC']]);
  }
  // Guaranteed bounded fallback for exact categories, with price pushed into SQL.
  // v3.2: broad probes push the category's typical accessory words into SQL
  // as NOT ILIKE, so fresh accessory rows cannot fill the page.
  const notAccessories=(ACCESSORY_PUSHDOWN[category]||[]).map(w=>['title','!'+w]);
  for(const alias of clues.brands.slice(0,1))
    push([['title',alias],['title',types[0]||category],...notAccessories]);
  for(const categoryAnchor of types.slice(0,3))
    push([['title',categoryAnchor],...notAccessories]);
  return sets.slice(0,12);
}
const ACCESSORY_PUSHDOWN={
  노트북:['파우치','가방','키스킨','케이스','필름','어댑터','충전기','거치대','배터리','액정'],
  스마트폰:['케이스','필름','강화유리','충전기','거치대','액정','유심','렌즈'],
  태블릿:['케이스','필름','강화유리','거치대','펜슬','펜촉'],
  이어폰:['케이스','이어팁','커버','스트랩','이어캡'],
  헤드폰:['케이스','이어패드','거치대','스탠드','쿠션'],
  외장하드:['케이스','파우치','케이블','도킹'],
  모니터:['모니터암','받침','거치','필름','브라켓'],
  키보드:['키캡','키스킨','손목','팜레스트'],
  마우스:['마우스패드','피트','그립'],
  청소기:['필터','먼지봉투','브러시','걸레','거치대','물걸레패드'],
  공기청정기:['필터','렌탈'],
  스피커:['스탠드','거치대','케이블'],
  시계:['스트랩','밴드','필름','케이스','충전'],
  기타:['카포','교본','피크','스트링','케이스','페달']
};
module.exports={buildProbes,deriveClues,brandsFromUser,brandMatches,deviceAnchors,modelClues,modelEvidence,linesFromUser,canonModel,aliasRegex,BRANDS};
