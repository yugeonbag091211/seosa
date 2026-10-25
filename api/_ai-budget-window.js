'use strict';
/**
 * Near-ceiling recommendations never expand the user's hard budget.
 * Product type / option verification remains the responsibility of the
 * existing AI identity gate.
 */
const LOW_PRICE_CUTOFF=50000;
const NEAR_BUDGET_WON=30000;
const GAMING_TITLE=/(?:게이밍|게임\s*전용|게임\s*헤드셋|gaming|gamer|e-sport|esports)/i;
const EXCLUDE_GAMING=/(?:게임|게이밍)[^.!?\n]{0,30}(?:말고|빼|제외|아니|싫|원치|안\s*돼)|(?:일상용|데일리용|통학용|출퇴근용)(?![^.!?\n]{0,20}(?:게임도|게임용도))/;
const ALLOW_GAMING=/(?:게임용|게이밍)(?:도|을|은|는)?\s*(?:괜찮|가능|상관\s*없|추천|필요|원해|찾아)|게임(?:도|을)\s*(?:할|해|하니까)/;
const CHEAPEST=/최저가|가장\s*싼|제일\s*싼|더\s*저렴한|무조건\s*(?:싸|저렴)|가격\s*최저|최소\s*비용/i;
const MULTIPLE=/(?:여러\s*(?:개|가지|모델|제품)|\d+\s*(?:개|가지)|다\s*보여|모두\s*보여|전부\s*보여|순위|목록|(?:서로|둘\s*중)\s*비교|(?:와|과|랑|vs)\s*[^\n]+\s*비교)/i;
function positivePrice(i){const p=Math.round(Number(i&&(i.price||i.lprice))||0);return Number.isSafeInteger(p)&&p>0?p:0;}
function nearBudgetWindow(items,constraints,question){
 const list=Array.isArray(items)?items.filter(Boolean):[],c=constraints||{};
 const anchor=Math.round(Number(c.budgetSaid||c.budgetMax)||0);
 const max=Math.round(Number(c.budgetMax)||0),min=Math.max(0,Math.round(Number(c.budgetMin)||0));
 if(!max||anchor<=LOW_PRICE_CUTOFF||c.budgetSoft||c.budgetRelax||CHEAPEST.test(String(question||'')))return{applies:false,within:list,outside:[],lower:0,upper:max};
 const lower=Math.max(min,anchor-NEAR_BUDGET_WON),upper=Math.min(max,anchor+NEAR_BUDGET_WON);
 if(lower>upper)return{applies:true,within:[],outside:list,lower,upper};
 const within=[],outside=[];
 for(const it of list)(positivePrice(it)>=lower&&positivePrice(it)<=upper?within:outside).push(it);
 return{applies:true,within,outside,lower,upper};
}
function gamingPreference(text){const q=String(text||'');if(ALLOW_GAMING.test(q))return false;if(EXCLUDE_GAMING.test(q))return true;return null;}
function avoidsGaming(item){return GAMING_TITLE.test(String(item&&item.title||''));}
function oneCardFollowup(question,history,intent){
 return intent==='C'&&Array.isArray(history)&&history.some(h=>h&&h.role==='user')&&!MULTIPLE.test(String(question||''));
}
function noNearMatchMessage(result){const won=n=>Math.round(n).toLocaleString('ko-KR')+'원';return won(result.lower)+'~'+won(result.upper)+'에서 요청하신 조건에 맞는 상품을 확인하지 못했어요. 더 저렴한 상품이나 제외하신 유형을 대신 추천하지 않을게요. 가격 범위를 넓혀 볼까요?';}
module.exports={LOW_PRICE_CUTOFF,NEAR_BUDGET_WON,nearBudgetWindow,gamingPreference,avoidsGaming,oneCardFollowup,noNearMatchMessage};
