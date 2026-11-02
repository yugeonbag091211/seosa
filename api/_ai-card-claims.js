'use strict';
/*
 * Compare free-form answer claims against the ACTUAL cards shown to users.
 * A Product listing may remain in the results even when the LLM narrates it
 * as filtered out. 2026-11-02 Production counterexample:
 *  answer: "중고 상품은 제외했고"
 *  card: "(중고이어폰)애플 에어팟 프로 2세대" (180,500원).
 *
 * This does not alter the cards, prices, ranking or user constraints; it only
 * prevents an objectively false claim about what the returned list contains.
 * If this happens, add an accurate short state disclosure.
 */
const USED_CARD_RE=/(?:중고|중고품|used[-\s]?(?:item|product)|pre[-\s]?owned)/i;
const USED_EXCLUSION_CLAIM=/(?:중고(?:\s*(?:상품|제품|매물|판매글|품))?\s*(?:은|는|을|를|도)?\s*(?:제외(?:했|하였|하고|한|된|됐|합니다|해|하여|되었)|뺐|빼고|걸렀|거른|포함하지\s*않|보여주지\s*않)|(?:전부|모두|모든)\s*(?:(?:후보|상품|제품|매물)(?:은|는)?\s*)?(?:신품|새상품|새제품)|(?:신품|새상품|새제품)\s*만\s*(?:골랐|추천했|선택했|보여))/i;
function hasUsedCard(cards){
  return (Array.isArray(cards)?cards:[]).some(c=>USED_CARD_RE.test(
    [c&&c.title,c&&c.identityNote,c&&c.note,c&&c.condition].filter(Boolean).join(' ')));
}
function filterClaims(text,cards){
  const source=String(text||'');
  if(!source||!hasUsedCard(cards)||!USED_EXCLUSION_CLAIM.test(source))return {text:source,changed:false,removed:0};
  let removed=0;
  const output=source.split('\n').map(line=>
    line.split(/(?<=[.!?。])\s+/).filter(sentence=>{
      if(USED_EXCLUSION_CLAIM.test(sentence)){removed++;return false;}
      return true;
    }).join(' ')
  ).join('\n').replace(/\n{3,}/g,'\n\n').trim();
  if(!removed)return {text:source,changed:false,removed:0};
  const note='아래 상품 카드에는 중고 판매글도 포함되어 있으므로 구매 전 상품 상태를 확인해 주세요.';
  return {text:(output?output+'\n\n':'')+note,changed:true,removed};
}
module.exports={hasUsedCard,filterClaims};
