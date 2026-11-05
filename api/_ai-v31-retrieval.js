'use strict';
// v3.1 bounded read-only DB probe planner.
// Uses product taxonomy, literal user clues, and verified product identity.
// Never learns user intent from seller listing text or model-generated brands.
const {searchAnchors}=require('./_ai-v31-taxonomy');
const safe=s=>String(s||'').normalize('NFKC').replace(/[^0-9a-zA-Z가-힣+\s-]/g,' ').replace(/\s+/g,' ').trim().slice(0,80);
const key=spec=>spec.map(f=>f.join(':')).join('|');
const brandLexicon=[
  ['소니',['소니','SONY']],['삼성',['삼성','Samsung']],['애플',['Apple','애플']],
  ['로지텍',['로지텍','Logitech']],['씨게이트',['씨게이트','Seagate']],
  ['WD',['WD','Western Digital']],['젠하이저',['젠하이저','Sennheiser']],
  ['LG',['LG','엘지']],['브리츠',['브리츠','Britz']],['JBL',['JBL']],
  ['샤오미',['샤오미','Xiaomi']],['레노버',['레노버','Lenovo']]
];
function brandsFromUser(text) {
  const s=safe(text);
  const found=[];
  for(const variants of brandLexicon.map(x=>x[1])){
    if(variants.some(v=>new RegExp('(?:^|[^a-z가-힣])'+v+'(?=$|[^a-z가-힣])','i').test(s)||s.includes(v))){
      found.push(...variants);break;
    }
  }
  return [...new Set(found)].slice(0,2);
}
function deviceAnchors(category,identity={}) {
  if(identity?.family==='ipad')return ['아이패드','iPad'];
  if(identity?.family==='galaxytab')return ['갤럭시탭','Galaxy Tab'];
  if(identity?.family==='airpods')return ['에어팟','AirPods'];
  if(identity?.family==='galaxybuds')return ['버즈','Galaxy Buds'];
  if(identity?.family==='iphone')return ['아이폰','iPhone'];
  if(identity?.family==='macbook')return ['맥북','MacBook'];
  if(category==='헤드폰')return ['헤드폰','헤드셋'];
  if(category==='이어폰')return ['이어폰','에어팟','버즈'];
  if(category==='외장하드')return ['외장하드','외장 SSD','외장SSD'];
  return searchAnchors(category).filter(s=>s.length>=2).slice(0,3);
}
function deriveClues(query,userText,identity) {
  const text=safe([query,userText].join(' '));
  const model=[];
  if(identity?.chip)model.push(String(identity.chip));
  const known=[...text.matchAll(/\b(?:WH-[A-Z0-9-]{4,}|T\d{1,2}|MX\s*MASTER|S\d{1,2}\s*FE\+?)\b/gi)];
  for(const m of known)if(!model.some(x=>x.toLowerCase()===m[0].toLowerCase()))model.push(m[0]);
  const size=identity?.screenInches?String(identity.screenInches):'';
  const store=identity?.storageGb?String(identity.storageGb):'';
  const storeAlternatives=store?Number(store)%1024===0?
    [String(Number(store)/1024)+'TB',String(Number(store)/1024)+'테라',store+'GB']:
    [store+'GB',store+'기가']: [];
  const wantsNoise=/(?:노이즈\s*캔슬링|ANC|노이즈캔슬링)/i.test(text);
  return {models:model.slice(0,2),size,storeAlternatives,brands:brandsFromUser(text),wantsNoise};
}
function buildProbes({query='',category='',userText='',identity={},minPrice,maxPrice}={}) {
  if(!category)return [];
  const clues=deriveClues(query,userText,identity);
  const types=deviceAnchors(category,identity),sets=[],seen=new Set();
  function push(spec){
    const filters=spec.map(([c,v])=>[c,safe(v)]).filter(([,v])=>v.length>=1);
    if(!filters.length)return;
    const k=key(filters);
    if(seen.has(k))return;
    seen.add(k);sets.push(filters);
  }
  // A full model number or named brand is stronger than a broad category hit.
  for(const model of clues.models) {
    for(const categoryAnchor of types.slice(0,2))push([['title',categoryAnchor],['title',model]]);
    if(clues.storeAlternatives.length)
      for(const storage of clues.storeAlternatives.slice(0,2))
        push([['title',model],['title',storage]]);
  }
  if(clues.size)for(const categoryAnchor of types.slice(0,2)) {
    if(clues.models.length)push([['title',categoryAnchor],['title',clues.models[0]],['title',clues.size]]);
    else push([['title',categoryAnchor],['title',clues.size]]);
  }
  if(clues.storeAlternatives.length){
    for(const categoryAnchor of types.slice(0,2))
      push([['title',categoryAnchor],['title',clues.storeAlternatives[0]]]);
  }
  for(const brand of clues.brands.slice(0,2))
    for(const categoryAnchor of types.slice(0,2))
      push([['title',brand],['title',categoryAnchor]]);
  if(clues.wantsNoise&&category==='헤드폰') {
    push([['title','헤드폰'],['title','노이즈']]);
    push([['title','헤드폰'],['title','ANC']]);
  }
  // Guaranteed bounded fallback for exact categories, with price pushed into SQL.
  for(const categoryAnchor of types.slice(0,2))
    push([['title',categoryAnchor]]);
  return sets.slice(0,9);
}
module.exports={buildProbes,deriveClues,brandsFromUser,deviceAnchors};
