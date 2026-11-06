'use strict';
// Shared, deterministic taxonomy for AI v3.1.
// GPT can suggest a category, but only the user's request may impose product identity.
const { requestedIdentity } = require('./_ai-v3-identity');
const norm = s => String(s||'').normalize('NFKC').toLowerCase();
const TYPES = [
  ['공기청정기',/(?:공기\s*청정기|air\s*purifier)/i,['공기청정기','air purifier']],
  ['외장하드',/(?:외장\s*(?:ssd|hdd|하드|디스크)|포터블\s*ssd|portable\s*ssd|external\s*(?:ssd|hard|drive)|저장장치)/i,['외장하드','외장 SSD','외장SSD','외장 HDD','포터블 SSD']],
  ['이어폰',/(?:이어폰|이어버드|에어팟|airpods|갤럭시\s*버즈|galaxy\s*buds|earbuds|in[\s-]?ear)/i,['이어폰','에어팟','airpods','이어버드','버즈','earbuds']],
  ['헤드폰',/(?:헤드폰|헤드셋|headphone|headset)/i,['헤드폰','헤드셋','headphone','headset']],
  ['태블릿',/(?:아이패드|ipad|갤럭시\s*탭|galaxy\s*tab|태블릿)/i,['아이패드','ipad','갤럭시탭','갤럭시 탭','태블릿']],
  ['스마트폰',/(?:아이폰|iphone|갤럭시\s*s\d|galaxy\s*s\d|스마트폰|휴대폰|핸드폰)/i,['아이폰','iphone','갤럭시','스마트폰','휴대폰']],
  ['노트북',/(?:노트북|갤럭시북|맥북|macbook|그램|thinkpad|ideapad|laptop)/i,['노트북','갤럭시북','맥북','그램','macbook','laptop']],
  ['모니터',/(?:모니터|monitor|display)/i,['모니터','monitor']],
  ['키보드',/(?:키보드|keyboard)/i,['키보드','keyboard']],
  ['마우스',/(?:마우스|mouse|mx\s*master)/i,['마우스','mouse']],
  ['청소기',/(?:청소기|로봇\s*청소기|로보락|roborock|vacuum)/i,['청소기','로보락','로봇청소기','vacuum']],
  ['스피커',/(?:스피커|speaker)/i,['스피커','speaker']],
  ['시계',/(?:스마트\s*워치|애플워치|스마트워치|시계|smartwatch)/i,['시계','스마트워치','애플워치']],
  ['기타',/(?:일렉\s*기타|어쿠스틱\s*기타|electric\s*guitar|acoustic\s*guitar)/i,['일렉기타','어쿠스틱기타','guitar']]
];
const TYPEMAP = new Map(TYPES.map(([type,regex,anchors])=>[type,{regex,anchors}]));
const FAMILY = {ipad:'태블릿',galaxytab:'태블릿',iphone:'스마트폰',galaxys:'스마트폰',
  airpods:'이어폰',galaxybuds:'이어폰',macbook:'노트북'};
function familyCategory(family){return FAMILY[family]||''}
function allTypes(text) {
  const matches=[];
  for(const [type,re] of TYPES) {
    const m=re.exec(String(text||''));
    if(m)matches.push({type,index:m.index,token:m[0]});
  }
  return matches.sort((a,b)=>a.index-b.index);
}
function explicitType(text) {
  const t=String(text||'');
  // The device may be a *compatibility target*, not the item being sold:
  // "아이패드용 키보드" / "아이패드 에어에 쓸 블루투스 키보드".
  const accessory=t.match(/(?:아이패드|ipad|태블릿|갤럭시\s*탭|galaxy\s*tab|맥북|macbook|노트북).{0,40}?(?:용|호환|쓸|쓰는|사용할|연결|키보드\s*케이스).{0,40}?(키보드|마우스)/i) ||
    t.match(/(?:아이패드|ipad|태블릿|갤럭시\s*탭|galaxy\s*tab|맥북|macbook|노트북).{0,40}?(키보드|마우스)\s*케이스/i);
  if(accessory)return accessory[1]==='마우스'?'마우스':'키보드';
  // In "earbuds, not that; headphones" the last explicit target wins.
  const corrections=t.split(/(?:말고|아니고|대신)/i);
  if(corrections.length>1){
    const later=allTypes(corrections.at(-1));
    if(later.length)return later[0].type;
  }
  const identity=requestedIdentity(t);
  if(identity.family&&FAMILY[identity.family]) {
    const named=allTypes(t);
    const output=named.find(x=>x.type!=='태블릿'&&x.type!=='스마트폰'&&x.type!=='노트북');
    if(output && /(?:용|호환|액세서리)/i.test(t))return output.type;
    return FAMILY[identity.family];
  }
  return allTypes(t)[0]?.type||'';
}
function canonicalCategory({message='',query='',planCategory='',priorCategory=''}={}) {
  // An explicit user noun dominates GPT's "완제품", "저장장치", "제품" or "무선".
  return explicitType(message)||explicitType(query)||explicitType(priorCategory)||
    explicitType(planCategory)||'';
}
function comparisonFromUtterance(message) {
  if(!/(비교|차이|vs\b|대\s*결)/i.test(message))return null;
  const mentions=allTypes(message),unique=[];
  for(const m of mentions)if(!unique.some(x=>x.type===m.type))unique.push(m);
  // Named products within the same category are still two distinct
  // comparison subjects: "Roborock vs cordless vacuum", "iPhone 16 vs 16e".
  // Only emit grounded phrases taken directly from the user's request.
  const pair=String(message||'').match(/^(.{2,100}?)\s*(?:vs\.?|이랑|랑|하고|와|과)\s*(.{2,100}?)\s*(?:가격\s*|성능\s*|사양\s*)?(?:비교|차이)/i);
  if(pair){
    const lhs=pair[1].trim().replace(/^(?:집에서\s*쓸|가정용\s*)/,'').trim();
    const rhs=pair[2].trim().replace(/^일반\s+/,'').replace(/\s*(?:가격|성능|사양)\s*$/,'');
    const leftType=explicitType(lhs),rightType=explicitType(rhs);
    if(leftType&&rightType&&lhs!==rhs)
      return {query:lhs,compareQuery:rhs,category:leftType};
  }
  if(unique.length<2)return null;
  return {query:unique[0].token,compareQuery:unique[1].token,category:unique[0].type};
}
// Persist user-confirmed device features across budget and follow-up turns.
function mergeFeatures(previous={},utterance='',changedProduct=false) {
  const value=changedProduct?{}:{wireless:previous.wireless===true,
    anc:previous.anc===true,externalSsd:previous.externalSsd===true};
  const s=String(utterance||'');
  const wireless=[...s.matchAll(/무선|블루투스|wireless|유선|wired/gi)];
  if(wireless.length)value.wireless=!/유선|wired/i.test(wireless.at(-1)[0]);
  if(/(?:\bANC\b|노이즈\s*캔슬링|노이즈캔슬링|노캔)/i.test(s)){
    value.anc=!/(?:ANC|노캔|노이즈\s*캔슬링).{0,7}(?:제외|빼고|없어도|말고)/i.test(s);
  }
  if(/(?:외장\s*SSD|포터블\s*SSD|portable\s*SSD|외장하드.{0,20}\bSSD\b|\bSSD\b.{0,16}외장)/i.test(s))
    value.externalSsd=true;
  else if(/(?:외장\s*HDD|외장하드\s*HDD)/i.test(s))value.externalSsd=false;
  return value;
}
function featureContext(message='',features={}) {
  const flags=[];
  if(features.wireless)flags.push('무선');
  if(features.anc)flags.push('ANC');
  if(features.externalSsd)flags.push('외장 SSD');
  return [message,...flags].join(' ');
}
function stripTaxonomy(title) {
  return String(title||'').split(/\/(?:디지털기기|pc\/주변기기|생활\/가전)/i)[0];
}
const PARTS=/(?:케이스|보호필름|보호\s*유리|충전기|거치대|스탠드|브라켓|어댑터|파우치|커버|스트랩|리필|펜촉|키캡|호환\s*케이스|스티커|교체용|이어팁|이어패드|필름\s*세트|필터\s*(?:세트|호환|교체)|(?:왼쪽|오른쪽|좌측|우측|한쪽)\s*(?:단품|유닛|이어버드|이어폰))/i;
const EARPIECE=/(?:이어폰|이어버드|earbuds|in[\s-]?ear|에어팟|airpods|갤럭시\s*버즈|galaxy\s*buds|이어\s*클립|이어클립|골전도|넥밴드)/i;
const HEADPHONE=/(?:헤드폰|헤드셋|headphone|headset|\bWH-CH\d)/i;
function ambiguousOptions(title,category) {
  if(category!=='외장하드'&&category!=='태블릿'&&category!=='스마트폰'&&category!=='노트북')return false;
  const t=stripTaxonomy(title),capacities=new Set();
  for(const m of t.matchAll(/(?<![0-9a-z])(\d{1,4})\s*(TB|GB|기가|테라|G)(?![a-z0-9])/gi)){
    const start=m.index||0,around=t.slice(Math.max(0,start-18),start+24);
    if(/\bRAM\b|메모리|램/i.test(around)&&Number(m[1])<=64)continue;
    const multiplier=/TB|테라/i.test(m[2])?1024:1,n=Number(m[1])*multiplier;
    if(n>=32&&n<=131072)capacities.add(n);
  }
  return capacities.size>1;
}
function isPart(title,type) {
  const t=stripTaxonomy(title);
  // A free pouch or film bundled WITH a real device is not the primary
  // merchandise. Preserve the device, but never allow a free keyboard
  // bundled WITH an iPad to masquerade as a standalone keyboard.
  const primary=t
    .replace(/(?:\+|\s)\s*(?:전용\s*)?(?:파우치|케이스|보호필름|스트랩)\s*(?:증정|제공|포함|세트)/gi,' ')
    .replace(/(?:\+|\s)\s*(?:사은품\s*)?(?:파우치|케이스|보호필름|스트랩)\s*증정/gi,' ');
  const integratedKeyboard=type==='키보드' &&
    /(?:블루투스|bluetooth)/i.test(primary) &&
    /키보드\s*케이스/i.test(primary);
  const accessoryCheck=integratedKeyboard?
    primary.replace(/키보드\s*케이스/gi,'키보드'):primary;
  if(PARTS.test(accessoryCheck))return true;
  if(type==='태블릿' &&
    /(?:micro\s*sd|sdxc|메모리\s*카드|tf\s*카드|sd\s*카드)/i.test(t) &&
    /(?:카드|card|sdxc)/i.test(t))return true;
  if(type==='외장하드' &&
    (/(?:케이블|cable|도킹\s*스테이션|도킹스테이션|enclosure)/i.test(t)) &&
    !/(?:케이블|cable)\s*(?:증정|포함|동봉|세트)/i.test(t))return true;
  if(type==='헤드폰'&&/(?:스템\s*캡|스템|탑캡|헤드셋\s*베어링|자전거|바이크\s*헤드셋|bike\s*headset)/i.test(t))return true;
  if(type==='외장하드'&&/(?:ssd\s*케이스|hdd\s*케이스|외장하드\s*(?:케이스|파우치|독|도킹)|외장\s*하드\s*케이스|NAS\s*서버|클로닝|하드카피|디스크\s*복제|동시\s*복제|스토리지\s*도킹)/i.test(t))return true;
  if(type==='모니터'&&/(?:모니터\s*(?:암|받침대|홀더|스탠드|거치)|monitor\s*(?:arm|stand|mount))/i.test(t))return true;
  if(type==='청소기' &&
    /(?:먼지\s*봉투|집진백|먼지백|교체\s*브러시|모터\s*필터|청소기\s*필터\s*(?:세트|교체|호환)|소모품|액세서리|청소기\s*부품)/i.test(t))return true;
  return false;
}
function productTypeMatches(title,category,requestedText='') {
  const t=stripTaxonomy(title),type=canonicalCategory({planCategory:category});
  if(!type||!t.trim())return false;
  // Monthly installment, lease and rental offers do not carry a verifiable
  // outright merchandise price. Only show them for explicit rental intent.
  if(/(?:\[렌탈\]|렌탈\s*(?:상품|가격|약정)?|월\s*렌탈|월정액|(?:\d{2,3})\s*개월\s*(?:약정|렌탈)?|대여료)/i.test(t) &&
    !/(?:렌탈|대여|구독)/i.test(requestedText))return false;
  // Listings that advertise multiple models/option choices cannot evidence
  // one priced, verified product configuration.
  if(/(?:모아보기|상품\s*모음|모델\s*선택|옵션\s*선택|옵션별|골라담기)/i.test(t))return false;
  // Seller texts may mention multiple categories; trust the principal item.
  const mentions=allTypes(t);
  if(mentions[0]&&mentions[0].type!==type&&
    ((type==='헤드폰'&&mentions[0].type==='마우스')||
     (type==='태블릿'&&mentions[0].type==='노트북')))return false;
  if(isPart(t,type)||ambiguousOptions(t,type))return false;
  // Seller headline may advertise a free accessory ahead of the actual device:
  // "[블루투스 키보드/무료증정]애플 아이패드 ..." sells an iPad, not a keyboard.
  const promotion=t.match(/^\[[^\]]{0,90}(?:무료\s*증정|사은품|덤\s*증정)[^\]]*\]/i);
  if(promotion){
    const actual=explicitType(t.slice(promotion[0].length));
    if(actual && actual!==type)return false;
  }
  // A requested feature must be evidenced by the actual seller listing.
  // Category words alone are never evidence of ANC functionality.
  if((type==='헤드폰'||type==='이어폰') &&
    /(?:무선|블루투스|wireless)/i.test(requestedText) &&
    !/(?:무선|블루투스|wireless|bluetooth|\bBT\d|TWS|에어팟|airpods|갤럭시\s*버즈)/i.test(t))return false;
  if((type==='헤드폰'||type==='이어폰') &&
    /(?:\bANC\b|노이즈\s*캔슬링|노이즈캔슬링|노캔)/i.test(requestedText)){
    if(/(?:패시브|passive|\bPNC\b)/i.test(t) &&
      !/(?:\bANC\b|액티브\s*노이즈|active\s*noise)/i.test(t))return false;
    if(!/(?:\bANC\b|노이즈\s*캔슬링|노이즈캔슬링|액티브\s*노이즈)/i.test(t))return false;
  }
  if(type==='헤드폰') {
    if(/(?:다이어리|문구용|노트\s*꾸미기|필통|지우개|만화책)/i.test(t))return false;
    if(!HEADPHONE.test(t))return false;
    // Ear-clip, bone-conduction, in-ear and TWS products are not over-ear headphones.
    if(EARPIECE.test(t))return false;
    return true;
  }
  if(type==='이어폰') {
    if(!EARPIECE.test(t))return false;
    if(/\b(?:프로\s*헤드폰|헤드폰\s*스탠드)\b/i.test(t))return false;
    return true;
  }
  if(type==='마우스' &&
    /(?:키보드\s*(?:및|와|\+|&|마우스).*?세트|키보드\s*마우스\s*세트|키보드\s*및\s*마우스\s*세트)/i.test(t))return false;
  if(type==='키보드' &&
    /(?:손목\s*받침|손목받침|팜레스트|키보드\s*스킨|키보드\s*필름|keycap|키캡|손목\s*패드)/i.test(t))return false;
  if(type==='키보드' &&
    /(?:시리즈용|교체형|교체용|replacement)/i.test(t) &&
    /(?:갤럭시\s*북|노트북|macbook|thinkpad|laptop)/i.test(t))return false;
  if(type==='키보드' && /(?:블루투스|bluetooth)/i.test(requestedText) &&
    !/(?:블루투스|bluetooth)/i.test(t))return false;
  if(type==='키보드' && /(?:아이패드\s*용|ipad\s*용)/i.test(requestedText) &&
    !/(?:아이패드|ipad|ipados)/i.test(t))return false;
  if(type==='스마트폰' &&
    // Contract/subsidy offers cannot use the displayed listing price as the
    // outright price without independent carrier-plan verification.
    /(?:공통지원금|통신사이동|번호이동|선택약정|완납개통|약정\s*가입|할부원금|통신사\s*지원금)/i.test(t))return false;
  if(type==='공기청정기' &&
    /(?:호환\s*.*(?:공기\s*청정기|퓨리케어)|(?:공기\s*청정기|퓨리케어).*?(?:호환|교체용)|(?:공기\s*청정기|퓨리케어).*?교체\s*필터)/i.test(t))return false;
  if(type==='태블릿'){
    // A purported Apple iPad running Android is a contradictory seller claim.
    // Do not treat it as a verified tablet (or a genuine Apple product).
    if(/(?:아이패드|\bipad\b)/i.test(t) &&
      /(?:안드로이드\s*\d|android\s*\d)/i.test(t))return false;
    if(/(?:전자책|이북\s*리더기|e-?book\s*reader|킨들|kindle)/i.test(t))return false;
  }
  if(type==='외장하드') {
    if(!/(?:외장\s*(?:하드|ssd|hdd|디스크)|portable\s*(?:ssd|hdd|hard)|external\s*(?:ssd|hdd|hard|drive)|포터블\s*ssd|my\s*passport|ssd\s*t7\b|하드디스크)/i.test(t))return false;
    if(/(?:외장\s*ssd|포터블\s*ssd|portable\s*ssd)/i.test(requestedText) && !/(?:ssd|솔리드\s*스테이트)/i.test(t))return false;
    return true;
  }
  const patterns={
    태블릿:/(?:아이패드|ipad|갤럭시\s*탭|galaxy\s*tab|태블릿)/i,
    스마트폰:/(?:아이폰|iphone|갤럭시\s*s\d|galaxy\s*s\d|스마트폰|휴대폰)/i,
    노트북:/(?:노트북|갤럭시북|맥북|macbook|그램|thinkpad|ideapad|laptop)/i,
    모니터:/(?:모니터|monitor|디스플레이)/i,
    키보드:/(?:키보드|keyboard)/i,
    마우스:/(?:마우스|mouse|mx\s*master)/i,
    공기청정기:/(?:공기\s*청정기|air\s*purifier)/i,
    청소기:/(?:청소기|로보락|roborock|vacuum)/i,
    스피커:/(?:스피커|speaker)/i,
    시계:/(?:시계|워치|watch)/i,
    기타:/(?:기타|guitar)/i
  };
  return !!(patterns[type]&&patterns[type].test(t));
}
function searchAnchors(category) {
  const entry=TYPEMAP.get(category);
  return entry?entry.anchors.slice():[];
}
module.exports={TYPES,allTypes,explicitType,canonicalCategory,comparisonFromUtterance,
  stripTaxonomy,ambiguousOptions,isPart,productTypeMatches,searchAnchors,
  mergeFeatures,featureContext,familyCategory};
