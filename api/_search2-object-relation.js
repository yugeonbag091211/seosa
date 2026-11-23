'use strict';
/**
 * Small, standalone sold-object relation layer for Search2.
 * It does NOT decide by whether the requested device name appears in a title.
 * A word naming the target device may describe COMPATIBILITY, not the thing sold.
 *
 * High-confidence relation evidence only; never remove candidates. Unknown stays unknown.
 * Vocabulary encodes commercial object kinds, NOT merchant/brand/individual product exceptions.
 */
const lower=s=>String(s||'').normalize('NFKC').toLowerCase();
const contains=(s,re)=>re.test(s);
const TYPES=[
  ['laptop',/(?:맥북|macbook|노트북|랩탑|laptop|갤럭시북|(?:lg\s*)?그램(?:\s|$))/i],
  ['earphone',/(?:이어폰|이어버드|earbuds?|earphones?)/i],
  ['robot_vacuum',/(?:로봇\s*청소기|robot\s*vacuum)/i],
  ['air_fryer',/(?:에어\s*프라이어|air\s*fryer)/i],
  ['coffee_machine',/(?:커피\s*머신|에스프레소\s*머신|coffee\s*machine|espresso\s*machine)/i],
  ['powerbank',/(?:보조\s*배터리|power\s*bank)/i],
  ['tablet',/(?:아이패드|ipad|태블릿|tablet|갤럭시탭)/i],
  ['smartwatch',/(?:스마트\s*워치|smart\s*watch|애플\s*워치|갤럭시\s*워치|apple\s*watch)/i],
  ['tire',/(?:타이어|tyres?|tires?)/i],
  ['monitor',/(?:모니터|monitor)/i],
  ['keyboard',/(?:키보드|keyboard)/i],
  ['mouse',/(?:마우스|mouse)/i],
  ['speaker',/(?:스피커|speaker)/i],
  ['shampoo',/(?:샴푸|shampoo)/i],
  ['detergent',/(?:세탁\s*세제|laundry\s*detergent)/i]
];
// A commercial target qualifier must be selected before the general device.
// e.g. "아이패드 케이스" requests an accessory, not an iPad.
const OBJECTS=[
  ['screen_protector',/(?:액정\s*보호\s*필름|보호\s*필름|보호필름|screen\s*protectors?|스크린\s*프로텍터|저반사\s*필름|프라이버시\s*필름|(?:고화질\s*)?저반사(?:\s+\d+매|\s+외부\d종))/i],
  ['case',/(?:케이스|하드\s*쉘|hardshell|cases?)/i],
  ['pouch',/(?:파우치|슬리브|pouch|sleeve)/i],
  ['strap',/(?:스트랩|시계\s*밴드|watch\s*bands?|watch\s*straps?)/i],
  ['shelf',/(?:선반|수납장|렌지대|정리대|rack|shelf)/i],
  ['cover',/(?:커버|덮개|covers?)/i],
  ['bag',/(?:가방|백팩|백팩|bag|backpack)/i],
  ['book',/(?:\[(?:국내도서|외국도서|도서|e북)\]|(?:도서|교재|입문서|가이드북|매뉴얼|드로잉\s*with|첫걸음)|\bbooks?\b)/i],
  ['light',/(?:조명|램프|light\s*bar|lamp)/i],
  ['inflator',/(?:공기압\s*주입기|공기\s*주입기|에어\s*펌프|타이어\s*펌프|inflator|air\s*pump)/i],
  ['wifi_rental',/(?:포켓\s*와이파이|와이파이\s*(?:대여|렌탈)|(?:wi-?fi|와이파이).*(?:대여|렌탈|공항\s*수령|데이터\s*무제한|무제한\s*데이터)|(?:데이터\s*무제한|무제한\s*데이터).*(?:wi-?fi|와이파이))/i],
  ['tour',/(?:투어|여행\s*상품|공항\s*수령|관광\s*상품|travel\s*tour)/i],
  ['planner',/(?:굿노트\s*속지|플래너|디지털\s*속지|planner)/i],
  ['ear_tip',/(?:이어팁|이어패드|ear\s*tips?|ear\s*pads?)/i],
  ['stand',/(?:거치대|스탠드|받침대|stand|holder)/i],
  ['charger',/(?:충전기|어댑터|charger|adapter)/i],
  ['keyboard_skin',/(?:키스킨|키캡|키보드\s*커버|keycaps?|keyboard\s*skin)/i],
  ['mousepad',/(?:마우스\s*패드|mousepad)/i],
  ['filter',/(?:필터|filter|먼지\s*봉투)/i],
  ['replacement',/(?:교체(?:용)?\s*부품|호환\s*부품|부속품|스페어\s*부품|냉각\s*팬|쿨링\s*팬|cooling\s*fan|spare\s*part)/i]
];
const GOODS_INTENT=new Set(['screen_protector','case','pouch','strap','shelf','cover',
  'bag','light','inflator','ear_tip','stand','charger','keyboard_skin','mousepad','filter']);
const SERVICE_OBJECTS=new Set(['book','wifi_rental','tour','planner']);
const PROFILE_BY_NAME=new Map(TYPES);
function matchFirst(s,items){for(const [type,re] of items)if(contains(s,re))return type;return null;}
function getIntent(query){
 const q=lower(query);
 const type=matchFirst(q,TYPES);
 if(!type)return {type:null,desired:null,category:'unknown'};
 // A deliberate accessory or saleable consumable query must remain a first-class intent.
 const desired=matchFirst(q,OBJECTS);
 return {type,desired:desired&&GOODS_INTENT.has(desired)?desired:null,
   category:desired&&GOODS_INTENT.has(desired)?'accessory':'main'};
}
function objectEvidence(title){
 const s=lower(title);
 const objects=OBJECTS.filter(([,re])=>contains(s,re)).map(([name])=>name);
 return {s,objects};
}
function isIncludedAccessory(s,name){
 const object=OBJECTS.find(([kind])=>kind===name);
 const found=object && object[1].exec(s);
 if(!found)return false;
 const after=s.slice(found.index+found[0].length,found.index+found[0].length+20);
 return /^\s*(?:(?:와|과|및|\+)\s*)?(?:함께\s*)?(?:포함|증정|동봉|탑재|내장|사은품|장착|일체형|제공)/i.test(after);
}
function isFeatureModifier(s,name,intent,typeRe){
 if(name!=='light')return false;
 // LED/ambient lighting on a speaker is a feature, not a lamp being sold.
 if(/(?:조명|램프)\s*(?:효과|기능|모드|지원|탑재)/i.test(s))return true;
 const found=OBJECTS.find(([kind])=>kind===name)?.[1].exec(s);
 return Boolean(found && intent.type==='speaker' &&
   typeRe.test(s.slice(found.index+found[0].length)));
}
function relation(query,title){
 const intent=typeof query==='string'?getIntent(query):query;
 if(!intent.type)return {grade:'unknown',score:1,reason:'query_unknown'};
 const {s,objects}=objectEvidence(title);
 const typeRe=PROFILE_BY_NAME.get(intent.type);
 const mentioned=typeRe.test(s);
 const wanted=intent.desired;
 const incompatible=objects.filter(x=>x!==wanted);
 const service=incompatible.find(x=>SERVICE_OBJECTS.has(x));
 // With a service or book selling object, device names merely describe subject/compatibility.
 if(service){
   return {grade:'non_product',score:0,reason:'sold_'+service};
 }
 if(intent.category==='accessory'){
   if(objects.includes(wanted)){
     if(mentioned && isIncludedAccessory(s,wanted))return {grade:'other_object',score:0,reason:'requested_accessory_is_gift'};
     return mentioned
       ? {grade:'target',score:3,reason:'requested_'+wanted}
       : {grade:'possible',score:2,reason:'requested_without_host_'+wanted};
   }
   if(incompatible.length)return {grade:'other_object',score:0,reason:'sold_'+incompatible[0]};
   return {grade:'unknown',score:1,reason:'accessory_not_identified'};
 }
 // No product-family noun -> no high-confidence MAIN promotion.
 // But identify replacement objects even if the target family is absent.
 if(!mentioned){
   if(incompatible.length)return {grade:'other_object',score:0,reason:'sold_'+incompatible[0]};
   return {grade:'unknown',score:1,reason:'target_not_mentioned'};
 }
 // An accessory offered with the main product is NOT the sold object.
 // This is conservative: only explicit inclusion when the device noun is present.
 const meaningful=incompatible.filter(x=>
   !isIncludedAccessory(s,x) && !isFeatureModifier(s,x,intent,typeRe));
 if(meaningful.length){
   // A screen protector with "맥북에어 M4" is still a screen protector.
   // Explicit accessory/other sold object takes priority over a device mention.
   return {grade:'other_object',score:0,reason:'sold_'+meaningful[0]};
 }
 // The user is looking for an object of the same type, not necessarily an identical model.
 return {grade:'target',score:3,reason:'target_'+intent.type};
}
module.exports={getIntent,relation,objectEvidence};
