'use strict';
// Shared, deterministic taxonomy for AI v3.1.
// GPT can suggest a category, but only the user's request may impose product identity.
const { requestedIdentity, listsManyModels } = require('./_ai-v3-identity');
const { principalItem } = require('./_ai-v32-listing');
const { mentionedPositively } = require('./_ai-v32-intent');
const norm = s => String(s||'').normalize('NFKC').toLowerCase();
// User-utterance product types. Search anchors list the GENERIC category noun
// first; brand/family nouns only follow (v3.2: "태블릿" before "아이패드",
// otherwise a "레노버 태블릿" request probes iPads).
const TYPES = [
  ['공기청정기',/(?:공기\s*청정기|air\s*purifier)/i,['공기청정기','청정기','air purifier']],
  ['외장하드',/(?:외장\s*(?:ssd|hdd|하드|디스크)|포터블\s*ssd|portable\s*ssd|external\s*(?:ssd|hard|drive)|저장장치|one\s*touch|원\s*터치|my\s*passport|\bhdd\b)/i,['외장하드','외장 SSD','외장SSD','외장 HDD','포터블 SSD']],
  ['이어폰',/(?:이어폰|이어버드|에어팟|airpods|갤럭시\s*버즈|galaxy\s*buds|earbuds|in[\s-]?ear)/i,['이어폰','이어버드','에어팟','airpods','버즈','earbuds']],
  ['헤드폰',/(?:헤드폰|헤드셋|headphone|headset)/i,['헤드폰','헤드셋','headphone','headset']],
  ['태블릿',/(?:아이패드|ipad|갤럭시\s*탭|galaxy\s*tab|태블릿|(?:레노버|샤오미|레드미)\s*(?:패드|탭)|redmi\s*pad|xiaomi\s*pad)/i,['태블릿','갤럭시탭','아이패드','ipad','갤럭시 탭']],
  ['스마트폰',/(?:아이폰|iphone|갤럭시\s*[sazm]\d|galaxy\s*[sazm]\d|갤럭시\s*(?:z\s*)?(?:폴드|플립)|스마트폰|휴대폰|핸드폰|자급제폰|공기계|(?:구글\s*)?픽셀\s*\d|pixel\s*\d)/i,['스마트폰','휴대폰','자급제','갤럭시','아이폰','iphone']],
  ['노트북',/(?:노트북|갤럭시\s*북|맥북|macbook|그램|thinkpad|씽크\s*패드|ideapad|아이디어\s*패드|비보북|vivobook|젠북|zenbook|크롬북|chromebook|laptop)/i,['노트북','갤럭시북','맥북','그램','macbook','laptop']],
  ['모니터',/(?:모니터|monitor|display)/i,['모니터','monitor']],
  ['키보드',/(?:키보드|keyboard)/i,['키보드','keyboard']],
  ['마우스',/(?:마우스|mouse|mx\s*master)/i,['마우스','mouse']],
  ['청소기',/(?:청소기|로봇\s*청소기|로보락|roborock|vacuum|(?:다이슨|dyson)\s*v\d{1,2})/i,['청소기','로보락','로봇청소기','vacuum']],
  ['스피커',/(?:스피커|speaker|사운드바|soundbar)/i,['스피커','speaker']],
  ['시계',/(?:스마트\s*워치|애플\s*워치|갤럭시\s*워치|galaxy\s*watch|apple\s*watch|(?:레드미|샤오미|어메이즈핏|가민|화웨이|핏빗)\s*(?:워치|밴드)|워치\s*\d|스마트\s*밴드|시계|smart\s*watch|smartwatch)/i,['스마트워치','시계','워치','애플워치']],
  // "기타" alone also means "etc." (ADPICK tags titles "[기타]"). A guitar is
  // named with its kind, "통기타", "guitar", or a shopping word right after.
  ['기타',/(?:(?:일렉(?:트릭)?|어쿠스틱|클래식|전자|베이스)\s*기타|통기타|guitar|기타\s*(?:본체|입문|연습|초보|추천|찾아|골라|세트|\d+\s*만\s*원))/i,['일렉기타','통기타','어쿠스틱 기타','클래식 기타','일렉 기타','guitar']]
];
const TYPEMAP = new Map(TYPES.map(([type,regex,anchors])=>[type,{regex,anchors}]));
const FAMILY = {ipad:'태블릿',galaxytab:'태블릿',iphone:'스마트폰',galaxys:'스마트폰',
  airpods:'이어폰',galaxybuds:'이어폰',macbook:'노트북',galaxybook:'노트북',
  galaxywatch:'시계',applewatch:'시계'};
function familyCategory(family){return FAMILY[family]||''}
function allTypes(text) {
  const matches=[];
  for(const [type,re] of TYPES) {
    const m=re.exec(String(text||''));
    if(m)matches.push({type,index:m.index,token:m[0]});
  }
  return matches.sort((a,b)=>a.index-b.index);
}
// Every product-type mention, in order (a type can appear more than once:
// "일렉기타 헤드폰 앰프가 아닌 일반 헤드폰").
function typeMentions(text) {
  const t=String(text||''), out=[];
  for(const [type,re] of TYPES){
    const g=new RegExp(re.source,'gi');
    let m;
    while((m=g.exec(t))!==null){
      if(!m[0]){g.lastIndex++;continue;}
      out.push({type,index:m.index,end:m.index+m[0].length,token:m[0]});
    }
  }
  out.sort((a,b)=>a.index-b.index||(b.end-b.index)-(a.end-a.index));
  const kept=[];
  for(const x of out)if(!kept.some(y=>x.index>=y.index&&x.end<=y.end))kept.push(x);
  return kept;
}
const NEGATOR=/(?:말고|아니고|아닌|아니라|제외|빼고|뺀|없이|대신|싫)/;
const MODIFIER_AFTER=/^[\s0-9a-z가-힣.]{0,16}?(?:용(?![a-z가-힣])|전용|호환|에\s*(?:쓸|쓰는|맞는|연결|호환)|연결|앱|어플|달린|겸용)/i;
// Korean noun phrases are head-final: the product the user wants is the LAST
// type mention that is neither negated ("이어폰 말고", "마우스 번들 아닌") nor a
// modifier/compatibility target ("아이폰 호환", "스마트폰 앱 연결되는",
// "키보드 달린"). Falls back to the last non-negated, then the first mention.
function headType(text) {
  const t=String(text||''),mentions=typeMentions(t);
  if(!mentions.length)return '';
  const info=mentions.map((m,i)=>{
    const next=i+1<mentions.length?mentions[i+1].index:t.length;
    const after=t.slice(m.end,Math.min(next,m.end+16));
    const neg=after.search(NEGATOR);
    return {...m,negated:neg>=0&&neg<=12,modifier:MODIFIER_AFTER.test(t.slice(m.end,next))};
  });
  const pick=[...info].reverse().find(x=>!x.negated&&!x.modifier)||
    [...info].reverse().find(x=>!x.negated)||info[0];
  return pick.type;
}
function explicitType(text) {
  const t=String(text||'');
  // A positively requested keyboard+mouse COMBO is sold as one set. Use
  // keyboard as the retrieval category, but validate that both are supplied.
  const combo=/(?:키보드\s*(?:및|와|\+|&)?\s*마우스|마우스\s*(?:및|와|\+|&)?\s*키보드)\s*(?:세트|콤보|combo|set)/i;
  if(mentionedPositively(t,combo))return '키보드';
  // The device may be a *compatibility target*, not the item being sold:
  // "아이패드용 키보드" / "아이패드 에어에 쓸 블루투스 키보드".
  const accessory=t.match(/(?:아이패드|ipad|태블릿|갤럭시\s*탭|galaxy\s*tab|맥북|macbook|노트북).{0,40}?(?:용|호환|쓸|쓰는|사용할|연결|맞는|맞게|전용|위한|키보드\s*케이스).{0,40}?(키보드|마우스)/i) ||
    t.match(/(?:아이패드|ipad|태블릿|갤럭시\s*탭|galaxy\s*tab|맥북|macbook|노트북).{0,40}?(키보드|마우스)\s*케이스/i);
  if(accessory)return accessory[1]==='마우스'?'마우스':'키보드';
  // The referenced laptop or tablet is a host device, not the requested
  // external-storage product. Recognize the target object after "연결할".
  if(/(?:맥북|macbook|노트북|아이패드|ipad).{0,55}?(?:연결할|연결|호환|쓸|맞는|위한|용).{0,35}?(?:외장\s*(?:ssd|hdd|하드)|포터블\s*ssd)/i.test(t))
    return '외장하드';
  // v3.2: head-noun resolution replaces "first mention wins".
  const head=headType(t);
  if(head)return head;
  const identity=requestedIdentity(t);
  if(identity.family&&FAMILY[identity.family])return FAMILY[identity.family];
  return '';
}
// A stored/canonical category name must round-trip ("기타" → "기타"). Before
// v3.2 explicitType("기타") returned "" and every guitar listing was rejected.
function canonicalName(category) {
  const c=String(category||'').trim();
  return TYPEMAP.has(c)?c:explicitType(c);
}
function canonicalCategory({message='',query='',planCategory='',priorCategory=''}={}) {
  // An explicit user noun dominates GPT's "완제품", "저장장치", "제품" or "무선".
  const fromUser=explicitType(message)||explicitType(query);
  if(fromUser)return fromUser;
  // The server's own stored category is trusted; GPT's exact canonical name is
  // used only when grounded in the conversation ("기타" also means "etc.").
  const prior=canonicalName(priorCategory);
  if(prior)return prior;
  const plan=String(planCategory||'').trim();
  if(TYPEMAP.has(plan)){
    if(plan!=='기타'||/기타|guitar/i.test(message+' '+query))return plan;
    return '';
  }
  return explicitType(plan)||'';
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
    anc:previous.anc===true,externalSsd:previous.externalSsd===true,gaming:previous.gaming===true};
  const s=String(utterance||'');
  // v3.4: «게이밍» is carried like «무선» (V057 lost it two turns later).
  if(/(?:게이밍|게임용|gaming)/i.test(s))
    value.gaming=!/(?:게이밍|게임용|gaming).{0,7}(?:제외|빼고|말고|아닌|필요\s*없)/i.test(s);
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
  if(features.gaming)flags.push('게이밍');
  return [message,...flags].join(' ');
}
function stripTaxonomy(title) {
  return String(title||'').split(/\/(?:디지털기기|pc\/주변기기|생활\/가전)/i)[0];
}
const PARTS=/(?:케이스|보호필름|보호\s*유리|충전기|거치대|스탠드|브라켓|어댑터|파우치|커버|스트랩|리필|펜촉|키캡|호환\s*케이스|스티커|교체용|이어팁|이어패드|필름\s*세트|필터\s*(?:세트|호환|교체)|(?:왼쪽|오른쪽|좌측|우측|한쪽)\s*(?:단품|유닛|이어버드|이어폰|낱개)|낱개\s*(?:유닛|이어버드|이어폰)|유닛\s*단품)/i;
// v3.4: AirPods Max is an over-ear headphone, not an earphone (hybrid run
// showed «애플 에어팟 맥스» as an «애플 이어폰» card).
const EARPIECE=/(?:이어폰|이어버드|earbuds|in[\s-]?ear|에어팟(?!\s*(?:맥스|max))|airpods(?!\s*max)|갤럭시\s*버즈|galaxy\s*buds|이어\s*클립|이어클립|골전도|넥밴드)/i;
const HEADPHONE=/(?:헤드폰|헤드셋|headphone|headset|\bWH-CH\d|에어팟\s*(?:맥스|max)|airpods\s*max)/i;
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
  // A "키보드 케이스 / 매직 키보드 / 키보드 폴리오" is a keyboard product
  // (v3.2: the word "블루투스" is not required to prove it).
  const integratedKeyboard=type==='키보드' &&
    /(?:키보드\s*케이스|매직\s*키보드|키보드\s*폴리오)/i.test(primary);
  const accessoryCheck=integratedKeyboard?
    primary.replace(/키보드\s*케이스/gi,'키보드'):primary;
  if(PARTS.test(accessoryCheck))return true;
  if(type==='이어폰' && /(?:낱개|한쪽\s*유닛|개별\s*유닛|유닛\s*(?:정품|개별|낱개|단품)|좌우\s*중\s*택1)/i.test(t))return true;
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
    /(?:먼지\s*봉투|집진백|먼지백|교체\s*브러시|모터\s*필터|청소기\s*필터\s*(?:세트|교체|호환)|소모품|액세서리|청소기\s*부품|(?:로봇\s*청소기|청소기).{0,18}(?:수납장|수납선반|수납대|가구|장식장|수납가구))/i.test(t))return true;
  return false;
}
// Categories whose cards must be ONE identifiable device (not a list of
// compatible models, a random assortment, or a defective/parts unit).
const DEVICE_TYPES=new Set(['스마트폰','태블릿','노트북','이어폰','헤드폰','시계','청소기','공기청정기','모니터','스피커','기타','외장하드']);
const HOME_ONLY=/(?:차량용|자동차용|차량\s*전용|차량\s*거치)/;
function coverageM2(t) {
  const m2=t.match(/(\d{1,3}(?:\.\d+)?)\s*(?:m2|㎡|m²|제곱\s*미터|제곱)/i);
  if(m2)return Number(m2[1]);
  const py=t.match(/(\d{1,2})\s*평(?:형|형대)?(?!\s*(?:이하|미만))/);
  return py?Number(py[1])*3.3:null;
}
// v3.2: attributes the USER required must be evidenced by the listing title.
// One table instead of scattered if-statements; each row is
// [categories, user asks (positive mention), title must show, title must NOT show].
const REQUIRED_ATTRIBUTES=[
  // wired request: a wireless-only listing does not satisfy it
  [['헤드폰','이어폰','마우스','키보드','스피커'],/(?:유선|wired)/i,null,
    t=>/(?:무선|블루투스|wireless|bluetooth|\bTWS\b)/i.test(t)&&!/(?:유선|유무선|wired|3\.5\s*mm|aux|usb\s*(?:전원|유선))/i.test(t)],
  // v3.4 (fast-check property 8, seed 20261120): the WIRELESS direction was
  // missing, so a DB listing "로지텍 유선 마우스" passed a "무선 마우스" request.
  // The listing must claim wireless, or be a line that only exists wireless.
  [['헤드폰','이어폰','마우스','키보드'],/(?:무선|블루투스|wireless|bluetooth)/i,
    /(?:무선|블루투스|wireless|bluetooth|\bTWS\b|유무선|2\.4\s*g(?:hz)?\b|라이트\s*스피드|lightspeed|logi\s*bolt|로지\s*볼트|unifying|\bBT\s*\d|에어팟|airpods|갤럭시\s*버즈|galaxy\s*buds|버즈\s*\d|\bbuds\d?\b|\bWF-|\bWH-(?:1000|CH|ULT)|\bWI-|quiet\s*comfort|\bQC\s*(?:울트라|ultra|\d)|mx\s*(?:master|keys|anywhere)|페블|pebble)/i],
  // v3.4 (V036): «조용한 마우스» is a stated requirement — silent-click evidence.
  [['마우스','키보드'],/(?:조용한|조용히|저소음|무소음|소음\s*(?:없|적)|silent|사일런트)/i,
    /(?:저소음|무소음|silent|사일런트|조용|noiseless|노이즈\s*리스)/i],
  // v3.4 (V057): «게이밍» stated earlier must still hold after «로지텍 제품만».
  [['마우스','키보드','헤드폰'],/(?:게이밍|게임용|gaming)/i,
    /(?:게이밍|게임|gaming|e\s*스포츠|esports|lightspeed|라이트\s*스피드|\bG\s?\d{3}\b|\bG\s*PRO\b|hero\s*\d|레이저|razer|스틸시리즈|steelseries|커세어|corsair|하이퍼\s*x|hyperx)/i],
  [['모니터'],/(?:게이밍|게임용|gaming)/i,
    /(?:게이밍|게임|gaming|(?:1[4-9]\d|2[0-9]\d|3[0-6]\d)\s*hz|프리\s*싱크|freesync|g-?sync|울트라\s*기어|ultragear|오디세이|odyssey)/i],
  // v3.4: a living-room purifier request excludes desk/portable/car minis.
  [['공기청정기'],/(?:거실|집\s*전체|대형|넓은\s*(?:공간|집|방))/i,null,
    t=>/(?:미니|초소형|탁상|휴대용|차량용|usb\s*(?:전원|충전))/i.test(t)],
  [['외장하드'],/(?:\bhdd\b|하드\s*디스크)/i,null,t=>/\bssd\b/i.test(t)&&!/(?:\bhdd\b|하드\s*디스크)/i.test(t)],
  [['모니터'],/(?:\bfhd\b|풀\s*hd|1920\s*[x×*]\s*1080)/i,/(?:\bfhd\b|풀\s*hd|full\s*hd|1920\s*[x×*]\s*1080|1080p)/i],
  [['모니터'],/(?:\bqhd\b|wqhd|2560\s*[x×*]\s*1440|\b2k\b)/i,/(?:\bqhd\b|wqhd|2560\s*[x×*]\s*14[04]0|\b2k\b|3440\s*[x×*]\s*1440)/i],
  [['모니터'],/(?:\buhd\b|\b4k\b|3840\s*[x×*]\s*2160)/i,/(?:\buhd\b|\b4k\b|3840\s*[x×*]\s*2160)/i],
  [['모니터'],/(?:울트라\s*와이드|ultra\s*wide|21\s*:\s*9)/i,/(?:울트라\s*와이드|ultra\s*wide|21\s*:\s*9|\bwfhd\b|\buwqhd\b|3440|2560\s*[x×*]\s*1080)/i],
  [['키보드'],/(?:기계식|mechanical)/i,/(?:기계식|mechanical|청축|적축|갈축|흑축|저소음\s*적축|축\b)/i],
  [['청소기'],/(?:스틱\s*청소기|스틱형|stick)/i,/(?:스틱|stick|핸디\s*스틱|무선\s*청소기|2\s*in\s*1)/i],
  [['청소기'],/(?:유선\s*(?:진공)?\s*청소기|코드\s*형)/i,/(?:유선|코드형|corded)/i],
  [['공기청정기','청소기'],/(?:hepa|헤파)/i,/(?:hepa|헤파|\bh1[0-4]\b)/i],
  [['스피커'],/(?:pc|컴퓨터|데스크\s*탑|데스크톱)\s*(?:용)?\s*(?:유선\s*)?스피커|pc\s*용/i,/(?:pc|컴퓨터|데스크\s*탑|데스크톱|게이밍|모니터|노트북|usb)/i],
  [['청소기'],/(?:로봇\s*청소기|로봇청소기)/i,null,t=>/(?:유리창|창문)\s*(?:로봇|청소)/.test(t)],
  [['스피커'],/(?:\btv\b|티비|텔레비전)/i,/(?:\btv\b|티비|hdmi|\barc\b|광\s*(?:단자|입력|케이블)|옵티컬|optical)/i],
  [['기타'],/(?:스트랫|strat|\bst\s*타입)/i,/(?:스트랫|strat|\bst\s*(?:타입|바디)|\bsst\d|\bst\d{2,3})/i],
  [['기타'],/(?:텔레\s*캐스터|텔레\b|\btl\s*타입)/i,/(?:텔레|tele|\btl\d)/i],
  [['기타'],/(?:레스폴|les\s*paul|\blp\s*타입)/i,/(?:레스폴|les\s*paul|\blp[\s-]?\d|\blp\s*(?:타입|커스텀))/i]
];
function requiredAttributesOk(t,type,req){
  for(const [types,asked,must,mustNot] of REQUIRED_ATTRIBUTES){
    if(!types.includes(type)||!mentionedPositively(req,asked))continue;
    if(must&&!must.test(t))return false;
    if(mustNot&&mustNot(t))return false;
  }
  // "180Hz 게임용 모니터": the listing's stated refresh must reach it.
  if(type==='모니터'){
    const hz=req.match(/(\d{2,3})\s*hz/i);
    if(hz){
      const stated=[...t.matchAll(/(\d{2,3})\s*hz/gi)].map(m=>Number(m[1]));
      if(!stated.length||Math.max(...stated)<Number(hz[1]))return false;
    }
  }
  return true;
}
function productTypeMatches(title,category,requestedText='') {
  const t=stripTaxonomy(title),type=canonicalName(category);
  if(!type||!t.trim())return false;
  const req=String(requestedText||'');
  // Deterministic model/line guards for the exact USER-named merchandise.
  // A different Winix family or S8 Pro Plus is not the same offered SKU.
  if(type==='공기청정기' && /(?:위닉스|winix).*?제로\s*s/i.test(req) &&
    !/제로\s*s|zero\s*s/i.test(t))return false;
  if(type==='청소기' && /(?:로보락|roborock)\s*s8\s*pro(?!\s*(?:plus|ultra|max|\+))/i.test(req) &&
    (!/s8\s*pro\b/i.test(t)||/s8\s*pro\s*(?:plus|ultra|max|\+)/i.test(t)))return false;
  // Keyboard cases and carrying bags are accessories unless the user
  // positively requested a keyboard case rather than the keyboard itself.
  if(type==='키보드'&&!mentionedPositively(req,/(?:키보드\s*(?:케이스|가방|파우치)|keyboard\s*case)/i) &&
    /(?:키보드\s*(?:케이스|가방|파우치)|keyboard\s*case)/i.test(t) &&
    !/(?:블루투스|bluetooth|무선|터치패드|트랙패드|백라이트|키보드\s*내장)/i.test(t))return false;
  const comboRequested=(type==='키보드'||type==='마우스')&&mentionedPositively(req,
    /(?:키보드\s*(?:및|와|\+|&)?\s*마우스|마우스\s*(?:및|와|\+|&)?\s*키보드)\s*(?:세트|콤보|combo|set)/i);
  // v3.2 principal item: the head of the title's main phrase is what is sold.
  const principal=principalItem(title);
  if(principal.kind==='accessory')return false;
  // A set's head noun may be either keyboard OR mouse; both are the sale.
  if(principal.kind==='device'&&principal.type&&principal.type!==type &&
    !(comboRequested&&['키보드','마우스'].includes(principal.type)))return false;
  // No identifiable item in the main phrase: only a model code the user
  // typed (e.g. "WH-1000XM5" with no "헤드폰" word) can still identify it.
  if(principal.kind===null&&(DEVICE_TYPES.has(type)||type==='마우스'||type==='키보드')){
    const codes=(req.match(/\b[a-z]{1,5}-?[a-z]?\d{2,4}[a-z]{0,3}\b/gi)||[]).map(x=>x.toLowerCase().replace(/[^0-9a-z]/g,''));
    const flatTitle=t.toLowerCase().replace(/[^0-9a-z]/g,'');
    if(!codes.some(c=>c.length>=4&&flatTitle.includes(c)))return false;
  }
  if(!requiredAttributesOk(t,type,req))return false;
  const keyboardMouseBundle=/(?:키보드\s*(?:및|와|\+|&)?\s*마우스|마우스\s*(?:및|와|\+|&)?\s*키보드)\s*(?:세트|콤보|combo|set)/i;
  if((type==='키보드'||type==='마우스') && mentionedPositively(req,keyboardMouseBundle) &&
    !keyboardMouseBundle.test(t))return false;
  // A Bluetooth speaker needs an explicit wireless claim from the listing;
  // a bare model name or 'portable' alone does not verify that feature.
  if(type==='스피커' && mentionedPositively(req,/(?:블루투스|무선|bluetooth|wireless)/i) &&
    !/(?:블루투스|무선|bluetooth|wireless|\bBT\s*\d)/i.test(t))return false;
  // v3.2: verify narrowly named USER requirements independently of GPT.
  // A related Dyson model is not evidence for the Pure Cool product line.
  if(type==='공기청정기' &&
    mentionedPositively(req,/(?:퓨어\s*쿨|pure\s*cool)/i) &&
    !/(?:퓨어\s*쿨|pure\s*cool)/i.test(t))return false;
  // A general adult smartwatch is not a children's/kids calling watch.
  if(type==='시계' &&
    mentionedPositively(req,/(?:어린이|키즈|아동|유아|초등|주니어|kids?)/i) &&
    !/(?:어린이|키즈|아동|유아|초등|주니어|kids?|child(?:ren)?)/i.test(t))return false;
  // Left-handed ergonomics must be stated; no assumption from a generic mouse.
  if(type==='마우스' &&
    mentionedPositively(req,/(?:왼손(?:잡이|용)?|left[ -]?hand(?:ed)?)/i) &&
    !/(?:왼손(?:잡이|용)?|양손(?:잡이|용|형)?|좌우\s*대칭|left[ -]?hand(?:ed)?|ambidextrous)/i.test(t))return false;
  // A listing advertising wired / wireless / Bluetooth variants is not proof
  // that the displayed price buys the requested wireless variant.
  if(type==='마우스' &&
    /유선\s*[/,·]?\s*무선(?:\s*블루투스)?/i.test(t) &&
    !/(?:유무선|겸용|듀얼\s*모드|dual[ -]?mode)/i.test(t))return false;
  // A listing with display-panel specs (QLED, 144hz, 4K) is a TV/monitor
  // that has speakers, not a speaker.
  if(type==='스피커'&&/(?:\bq?led\b|\boled\b|qled|\b4k\b|\d{2,3}\s*hz\s*주사율|\d{2,3}\s*인치\s*(?:tv|티비))/i.test(t))return false;
  // Keyboard-and-mouse combos are neither a keyboard nor a mouse purchase.
  if((type==='키보드'||type==='마우스')&&!mentionedPositively(req,/(?:세트|콤보|combo|번들)/)&&
    /(?:마우스\s*(?:\+|&|및|와)?\s*키보드|키보드\s*(?:\+|&|및|와)?\s*마우스)\s*(?:세트|set|콤보|combo)/i.test(t))return false;
  // A monitor listing offering several screen sizes has no single price.
  if(type==='모니터'){
    const sizes=new Set([...t.matchAll(/(?<![\d.])(1[5-9]|[2-4]\d)(?:\.\d)?\s*(?:인치|형|["″])?\s*(?=,|\/|인치|형|\s*,)/g)].map(m=>m[1]));
    if(/(?:\d{2}\s*,\s*){2,}\d{2}\s*인치/.test(t)||sizes.size>=3)return false;
  }
  if(DEVICE_TYPES.has(type)){
    if(['스마트폰','태블릿','노트북','이어폰','시계','청소기'].includes(type)&&listsManyModels(t))return false;
    // "랜덤기획전", "모델 랜덤" — no identifiable item (a random colour is fine).
    if(/랜덤/.test(t)&&!/(?:색상|컬러|색)\s*랜덤|랜덤\s*(?:색상|컬러)/.test(t))return false;
    if(/(?:배터리\s*(?:없음|없는|미장착|불량)|부품용|고장(?:품|난)?|수리용)/.test(t))return false;
  }
  // Car-only appliances do not answer a home request (and vice versa is fine).
  if((type==='공기청정기'||type==='청소기'||type==='모니터')&&HOME_ONLY.test(t)&&
    !/(?:가정용|겸용|원룸|사무실|홈)/.test(t)&&!/(?:차량|자동차|차\s*안|차에서|운전)/.test(req))return false;
  // "10평 거실용": a purifier whose stated coverage is smaller cannot serve it.
  if(type==='공기청정기'){
    const room=req.match(/(\d{1,2})\s*평/);
    if(room){
      const need=Number(room[1])*3.3,cov=coverageM2(t);
      if(cov!=null&&cov<need*0.9)return false;
      if(cov==null&&need>=20&&/(?:미니|소형|원룸|탁상|휴대용|데스크)/.test(t))return false;
    }
  }
  // Monthly installment, lease and rental offers do not carry a verifiable
  // outright merchandise price. Only show them for explicit rental intent.
  // "렌탈 말고 / 렌탈 안 하고" mentions rental only to refuse it (v3.2).
  if(/(?:\[렌탈\]|렌탈\s*(?:상품|가격|약정)?|월\s*렌탈|월정액|(?:\d{2,3})\s*개월\s*(?:약정|렌탈)?|대여료)/i.test(t) &&
    !mentionedPositively(requestedText,/(?:렌탈|렌털|대여|구독)/))return false;
  // Listings that advertise multiple models/option choices cannot evidence
  // one priced, verified product configuration.
  if(/(?:모아보기|상품\s*모음|모델\s*선택|옵션\s*선택|옵션별|골라담기|랜덤\s*발송|랜덤\s*모델|[1-9]\s*[~\-]\s*[1-9]\s*세대\s*모음)/i.test(t))return false;
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
    // v3.2: ENC / CVC / call-mic noise cancelling is not ANC.
    const anc=t.replace(/(?:\bENC\b|\bCVC\s*\d*(?:\.\d)?|통화\s*(?:용)?|마이크)\s*(?:노이즈\s*캔슬링|노이즈캔슬링|소음\s*제거)/gi,' ');
    if(!/(?:\bANC\b|노이즈\s*캔슬링|노이즈캔슬링|액티브\s*노이즈)/i.test(anc))return false;
  }
  // v3.2: "앱 연결/와이파이/IoT" is a feature the listing must evidence.
  if(/(?:앱|어플|스마트폰\s*(?:연동|연결)|와이파이|wi-?fi|iot|원격\s*제어)/i.test(req)&&
    ['공기청정기','청소기','스피커'].includes(type)&&
    !/(?:앱|app|어플|iot|wi-?fi|와이파이|스마트\s*(?:싱스|홈|제어|IoT)|thinq|씽큐|미홈|mi\s*home|tuya|투야|알렉사|alexa|구글\s*홈|카카오|스마트폰\s*(?:연동|제어))/i.test(t))return false;
  if(type==='헤드폰') {
    // Audio headset head-worn microphones and single-ear call earpieces
    // are not over-ear music headphones.
    if(/(?:헤드셋\s*마이크|마이크\s*헤드셋|UHF\s*(?:무선)?\s*헤드셋\s*마이크|모노\s*헤드셋|핸즈프리\s*헤드셋)/i.test(t))return false;
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
  // v3.2: only a POSITIVE mention is a requirement ("로봇청소기는 빼줘" is not).
  if(type==='청소기'&&mentionedPositively(requestedText,/(?:로봇\s*청소기|로봇청소기|robot\s*vacuum)/) &&
    !/(?:로봇\s*청소기|로봇청소기|robot\s*vacuum|로보락|roborock)/i.test(t))return false;
  // A display monitor is not an in-ear/studio audio "monitor".
  if(type==='모니터'&&/(?:이어\s*모니터|인이어|in-?ear|\bIEM\b|모니터\s*(?:헤드폰|헤드셋|스피커|이어폰)|모니터링)/i.test(t)&&
    !/(?:\d{2}(?:\.\d)?\s*(?:인치|형)|\bfhd\b|\bqhd\b|\buhd\b|\d{2,3}\s*hz)/i.test(t))return false;
  if(type==='마우스' &&
    /(?:키보드\s*(?:및|와|\+|&|마우스).*?세트|키보드\s*마우스\s*세트|키보드\s*및\s*마우스\s*세트)/i.test(t))return false;
  if(type==='키보드' &&
    /(?:손목\s*받침|손목받침|팜레스트|키보드\s*스킨|키보드\s*필름|keycap|키캡|손목\s*패드)/i.test(t))return false;
  if(type==='키보드' &&
    /(?:시리즈용|교체형|교체용|replacement)/i.test(t) &&
    /(?:갤럭시\s*북|노트북|macbook|thinkpad|laptop)/i.test(t))return false;
  if(type==='키보드' && mentionedPositively(requestedText,/(?:블루투스|bluetooth)/) &&
    !/(?:블루투스|bluetooth)/i.test(t))return false;
  if(type==='키보드' &&
    /(?:아이패드|ipad).{0,38}?(?:용|호환|쓸|쓰는|사용할|맞는|전용|위한)/i.test(requestedText) &&
    !/(?:아이패드|ipad|ipados)/i.test(t))return false;
  // A case sold for iPad Pro is not evidence it fits an iPad Air.
  if(type==='키보드' && /(?:아이패드|ipad)\s*(?:에어|air)/i.test(requestedText) &&
    /키보드\s*케이스/i.test(t)){
    if(!/(?:아이패드|ipad).{0,16}(?:에어|air)/i.test(t))return false;
    // A fitted tablet-keyboard case is model-size-specific; do not use an
    // "iPad Pro 11" or "Air 13" case for an Air 11 request.
    const requestedSize=requestedText.match(/(?:아이패드|ipad).{0,35}?\b(11|13)\s*(?:인치|inch)/i);
    if(requestedSize){
      const actualSizes=[...t.matchAll(/(?<!\d)(11|13|12\.9)\s*(?:인치|inch)?(?!\d)/gi)]
        .map(m=>Number(m[1]));
      if(!actualSizes.includes(Number(requestedSize[1])))return false;
    }
    const needChip=requestedText.match(/\bM([1-9])\b/i);
    if(needChip && !new RegExp('\\bM'+needChip[1]+'\\b','i').test(t))return false;
  }
  if(type==='스마트폰' &&
    // Contract/subsidy offers cannot use the displayed listing price as the
    // outright price without independent carrier-plan verification.
    /(?:공통지원금|통신사이동|번호이동|선택약정|완납개통|약정\s*가입|할부원금|통신사\s*지원금)/i.test(t))return false;
  // Carrier-free status cannot be inferred merely from "sealed" or "new".
  if(type==='스마트폰'&&/(?:자급제|unlocked)/i.test(requestedText) &&
    !/(?:자급제|공기계|unlocked)/i.test(t))return false;
  if(type==='공기청정기' &&
    /(?:호환\s*.*(?:공기\s*청정기|퓨리케어)|(?:공기\s*청정기|퓨리케어).*?(?:호환|교체용)|(?:공기\s*청정기|퓨리케어).*?교체\s*필터)/i.test(t))return false;
  if(type==='태블릿'){
    // Pen displays are peripherals requiring a host computer, not general
    // standalone Android/iPad tablets. Seller uses similar Korean nouns.
    if(/(?:액정\s*타블렛|액정\s*태블릿|드로잉\s*(?:타블렛|태블릿)|(?:그래픽|펜)\s*(?:타블렛|태블릿)|드로잉\s*패드|펜\s*디스플레이|pen\s*display|XPPEN|XP-PEN|와콤|wacom|이지드로잉|휴이온|huion|가오몬|gaomon)/i.test(t) &&
      !mentionedPositively(requestedText,/(?:액정\s*타블렛|액정\s*태블릿|드로잉\s*(?:타블렛|태블릿)|(?:그래픽|펜)\s*(?:타블렛|태블릿)|펜\s*디스플레이)/))
      return false;
    // A purported Apple iPad running Android is a contradictory seller claim.
    // Do not treat it as a verified tablet (or a genuine Apple product).
    if(/(?:아이패드|\bipad\b)/i.test(t) &&
      /(?:안드로이드\s*\d|android\s*\d)/i.test(t))return false;
    if(/(?:전자책|이북\s*리더기|e-?book\s*reader|킨들|kindle)/i.test(t))return false;
  }
  if(type==='외장하드') {
    if(!/(?:외장\s*(?:하드|ssd|hdd|디스크)|portable\s*(?:ssd|hdd|hard)|external\s*(?:ssd|hdd|hard|drive)|포터블\s*ssd|my\s*passport|ssd\s*t7\b|하드디스크)/i.test(t))return false;
    // When the user excludes mixed-capacity listings, require one explicit
    // capacity in the item title. Otherwise the displayed price has no
    // verified configuration to attach to.
    if(/(?:용량.{0,15}(?:여러|섞|옵션)|여러.{0,12}용량)/i.test(requestedText) &&
      !/(?:\d{2,4})\s*(?:gb|기가|tb|테라)/i.test(t))return false;
    if(/(?:외장\s*ssd|포터블\s*ssd|portable\s*ssd)/i.test(requestedText) && !/(?:ssd|솔리드\s*스테이트)/i.test(t))return false;
    return true;
  }
  const patterns={
    태블릿:/(?:아이패드|ipad|갤럭시\s*탭|galaxy\s*tab|태블릿)/i,
    스마트폰:/(?:아이폰|iphone|갤럭시\s*s\d|galaxy\s*s\d|스마트폰|휴대폰)/i,
    노트북:/(?:노트북|갤럭시북|맥북|macbook|그램|thinkpad|ideapad|laptop)/i,
    모니터:/(?:모니터(?!링)|monitor(?!ing)|디스플레이)/i,
    키보드:/(?:키보드|keyboard)/i,
    마우스:/(?:마우스|mouse|mx\s*master)/i,
    공기청정기:/(?:공기\s*청정기|air\s*purifier)/i,
    청소기:/(?:청소기|로보락|roborock|vacuum)/i,
    스피커:/(?:스피커|speaker)/i,
    시계:/(?:시계|워치|watch|스마트\s*밴드)/i,
    // Guitar listings name the instrument kind; bare "기타" is a shop tag.
    기타:/(?:(?:일렉(?:트릭)?|어쿠스틱|클래식|통|전자|베이스|입문용?|연습용|미니|여행용|\d{2}\s*인치)\s*기타|통기타|guitar)/i
  };
  if(type==='기타'){
    if(/(?:우쿨렐레|ukulele)/i.test(t))return false;
    // Guitar kind is a different instrument: classical (nylon) ≠ acoustic
    // (steel) ≠ electric. A kind the user named must be evidenced.
    const kinds=[['classical',/(?:클래식\s*기타|classical|나일론)/i,/(?:클래식|classical|나일론)/i],
      ['electric',/(?:일렉(?:트릭)?\s*기타|전자\s*기타|electric)/i,/(?:일렉|전자\s*기타|전기\s*기타|electric)/i],
      ['acoustic',/(?:어쿠스틱\s*기타|통기타|acoustic)/i,/(?:어쿠스틱|통기타|acoustic)/i],
      ['bass',/(?:베이스\s*기타|bass\s*guitar)/i,/(?:베이스|bass)/i]];
    for(const [,asked,evidence] of kinds)
      if(mentionedPositively(req,asked)&&!evidence.test(t))return false;
    // Size the user required must be evidenced ("어린이용 미니", "풀사이즈").
    if(/(?:미니|어린이|아동|키즈|주니어|3\s*\/\s*4|1\s*\/\s*2)/.test(req)&&
      !/(?:미니|어린이|아동|키즈|주니어|3\s*\/\s*4|1\s*\/\s*2|3[0-6]\s*인치)/.test(t))return false;
    if(/(?:풀\s*사이즈|full\s*size)/i.test(req)&&
      !/(?:풀\s*사이즈|full\s*size|4[01]\s*인치|드레드넛|dreadnought|\bOM\b|점보|jumbo)/i.test(t))return false;
    // "본체만 / 앰프 없이": an amp package is not the body alone.
    if(/(?:본체만|앰프\s*(?:없이|말고|빼고|제외)|앰프\s*(?:가|는)?\s*아닌)/.test(req)&&
      /(?:앰프\s*(?:포함|세트|패키지)|풀\s*패키지|앰프\s*\+)/.test(t))return false;
  }
  // A laptop listing states what it is: CPU, memory/storage, OS, screen or a
  // laptop line. A bare "노트북" word is usually a compatibility mention
  // (cables, bags, books such as "노트북 하나로 …").
  if(type==='노트북'&&!/(?:\bi[3579]\b|i[3579]\s*-?\s*\d{3,5}|코어\s*i|core\s*(?:i|ultra)|울트라\s*[579]|ultra\s*[579]|라이젠|ryzen|셀러론|celeron|펜티엄|pentium|\bn\d{3,4}\b|\bm[1-5]\b|스냅드래곤|snapdragon|\d+\s*(?:gb|기가)|\bssd|\bram\b|윈도우|windows|win\s*1[01]|\d{2}(?:\.\d)?\s*(?:인치|형|")|\d{2}\.\d|노트북\s*\d{2}\b|크롬\s*os|chrome\s*os|macos|맥북|macbook|그램|갤럭시\s*북|비보북|vivobook|젠북|zenbook|아이디어\s*패드|ideapad|씽크\s*패드|thinkpad|인스피론|inspiron|파빌리온|pavilion|엘리트북|elitebook|크롬북|chromebook|\b\d{2}[a-z]{1,2}\d{2,3}[a-z]?\b|nt\d{3})/i.test(t))return false;
  if(type==='스마트폰'){
    if(principal.type!=='스마트폰')return false;
    // A handset listing names a handset: a model line, a model code, or an
    // unlocked/blank device. A bare "스마트폰" mention is a compatibility word.
    if(!/(?:갤럭시\s*(?:s|a|m|z|퀀텀|와이드|점프|버디)\s*\d|갤럭시\s*(?:z\s*)?(?:폴드|플립)|(?:아이폰|iphone)\s*(?:\d|se)|(?:픽셀|pixel)\s*\d|sm-[saf]\d{3}|자급제|공기계|unlocked|(?:샤오미|레드미|포코|모토로라|motorola|낫싱|nothing|오포|oppo|비보|vivo|화웨이|huawei|tcl|zte|노키아|nokia)\s*.{0,14}\d)/i.test(t))return false;
  }
  // The sold item was identified as this kind of device ("갤럭시 A15 ...
  // 공기계 SM-A155", "레노버 Idea Tab Plus") — the keyword list is a fallback.
  if(principal.kind==='device'&&principal.type===type)return true;
  return !!(patterns[type]&&patterns[type].test(t));
}
function searchAnchors(category) {
  const entry=TYPEMAP.get(category);
  return entry?entry.anchors.slice():[];
}
module.exports={TYPES,allTypes,explicitType,canonicalCategory,canonicalName,comparisonFromUtterance,
  stripTaxonomy,ambiguousOptions,isPart,productTypeMatches,searchAnchors,
  mergeFeatures,featureContext,familyCategory,headType,typeMentions,coverageM2};
