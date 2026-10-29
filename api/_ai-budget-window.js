'use strict';
/**
 * Near-ceiling recommendations never expand the user's hard budget.
 * Product type / option verification remains the responsibility of the
 * existing AI identity gate.
 *
 * "15만원 이하" prefers 12~15만원 offers. It is a preference, not a second
 * budget: when nothing verified sits near the ceiling, the cheaper offers that
 * are still inside the budget are shown with a notice (fallbackNotice) instead
 * of refusing — "그램 200만원 이하" used to end with "197만~200만원에서 못 찾음"
 * while 159만원 and 64.5만원 gram laptops were inside the budget (2026-10-26).
 * The window scales with the ceiling (20%, at least 3만원): a 3만원 window is
 * "near" for 15만원 but meaningless for 200만원.
 */
const LOW_PRICE_CUTOFF=50000;
const NEAR_BUDGET_WON=30000;
const NEAR_BUDGET_RATIO=0.2;
const GAMING_TITLE=/(?:게이밍|게임\s*전용|게임\s*헤드셋|gaming|gamer|e-sport|esports)/i;
const EXCLUDE_GAMING=/(?:게임|게이밍)[^.!?\n]{0,30}(?:말고|빼|제외|아니|싫|원치|원하(?:지\s*)?않|안\s*돼)|(?:일상용|데일리용|통학용|출퇴근용)(?![^.!?\n]{0,20}(?:게임도|게임용도))/;
const ALLOW_GAMING=/(?:게임용|게이밍)(?:도|을|은|는)?\s*(?:괜찮|가능|상관\s*없|추천|필요|원해|찾아)|게임(?:도|을)\s*(?:할|해|하니까)/;
const CHEAPEST=/최저가|가장\s*싼|제일\s*싼|더\s*저렴한|무조건\s*(?:싸|저렴)|가격\s*최저|최소\s*비용/i;
const MULTIPLE=/(?:여러\s*(?:개|가지|모델|제품)|\d+\s*(?:개|가지)|다\s*보여|모두\s*보여|전부\s*보여|순위|목록|둘\s*다|둘의\s*(?:가격|판매가|현재가)|두\s*(?:개(?:의)?\s*(?:가격|판매가|현재가|결제)|제품|모델|상품)|앞의\s*두|비교한\s*(?:두|것)|둘\s*중|어느\s*쪽|(?:서로|둘\s*중)\s*비교|(?:와|과|랑|vs)\s*[^\n]+\s*비교)/i;
function positivePrice(i){const p=Math.round(Number(i&&(i.price||i.lprice))||0);return Number.isSafeInteger(p)&&p>0?p:0;}
function nearBudgetWindow(items,constraints,question){
 const list=Array.isArray(items)?items.filter(Boolean):[],c=constraints||{};
 const anchor=Math.round(Number(c.budgetSaid||c.budgetMax)||0);
 const max=Math.round(Number(c.budgetMax)||0),min=Math.max(0,Math.round(Number(c.budgetMin)||0));
 if(!max||anchor<=LOW_PRICE_CUTOFF||c.budgetSoft||c.budgetRelax||CHEAPEST.test(String(question||'')))return{applies:false,within:list,outside:[],lower:0,upper:max};
 const width=Math.max(NEAR_BUDGET_WON,Math.round(anchor*NEAR_BUDGET_RATIO));
 const lower=Math.max(min,anchor-width),upper=Math.min(max,anchor+width);
 if(lower>upper)return{applies:true,within:[],outside:list,lower,upper};
 const within=[],outside=[];
 for(const it of list)(positivePrice(it)>=lower&&positivePrice(it)<=upper?within:outside).push(it);
 return{applies:true,within,outside,lower,upper};
}
/**
 * An exception requires explicit, non-conflicting support and non-support
 * statements for the same requested feature in the respective titles.
 * Mere absence of a feature from a title is never evidence of non-support.
 * Only the narrowly defined ANC wording below is currently supported.
 */
function verifiedFeatureAlternatives(window, wanted) {
 const near=window&&window.within||[],outside=window&&window.outside||[];
 if(!window||!window.applies||!near.length||!Array.isArray(wanted)||!wanted.includes('노이즈캔슬링'))return[];
 const supported=it=>/(?:노이즈\s*캔슬링|\bANC\b)\s*(?:기능\s*)?(?:지원|탑재)/i.test(String(it&&it.title||''));
 const unsupported=it=>/(?:노이즈\s*캔슬링|\bANC\b)\s*(?:기능\s*)?(?:미지원|미탑재|없음)/i.test(String(it&&it.title||''));
 if(!near.every(it=>unsupported(it)&&!supported(it)))return[];
 return outside.filter(it=>positivePrice(it)>0&&positivePrice(it)<window.lower
   && supported(it)&&!unsupported(it));
}
function featureAlternativeNotice(){
 return '예산에 가까운 후보는 상품명에 노이즈캔슬링 미지원으로 표시되어 있고, 더 저렴한 후보는 노이즈캔슬링 지원으로 표시되어 있어 함께 평가했어요. 판매처에서 실제 기능과 옵션을 다시 확인해 주세요.';
}
function gamingPreference(text){const q=String(text||'');if(ALLOW_GAMING.test(q))return false;if(EXCLUDE_GAMING.test(q))return true;return null;}
function avoidsGaming(item){return GAMING_TITLE.test(String(item&&item.title||''));}
/**
 * A follow-up shop turn selects one card, including when the user changes
 * category. Explicit multi-product requests are the only card-count exception.
 */
function oneCardFollowup(question,history,intent){
 return ['C','D','E'].includes(String(intent||''))&&Array.isArray(history)&&history.some(h=>h&&h.role==='user')&&!MULTIPLE.test(String(question||''));
}
function won(n){const v=Math.round(n);return v%10000===0?(v/10000).toLocaleString('ko-KR')+'만원':v.toLocaleString('ko-KR')+'원';}
/** Shown above the answer when no verified offer sat near the ceiling and cheaper in-budget offers are listed instead. */
function fallbackNotice(result){
 return '요청하신 예산 상한('+won(result.upper)+')에 가까운 '+won(result.lower)+'~'+won(result.upper)+' 가격대에서는 확인된 상품이 없어, 예산 안의 더 저렴한 상품으로 안내드려요.';
}
module.exports={LOW_PRICE_CUTOFF,NEAR_BUDGET_WON,NEAR_BUDGET_RATIO,nearBudgetWindow,verifiedFeatureAlternatives,featureAlternativeNotice,gamingPreference,avoidsGaming,oneCardFollowup,fallbackNotice};
