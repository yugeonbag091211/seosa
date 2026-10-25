'use strict';
/*
 * User budget is a price target, not permission to fill the entire 0..cap
 * with unrelated cheap products. For ceilings > ₩50,000 prefer only offers
 * within ₩30,000 of the stated target. The stated "이하" ceiling is never
 * exceeded. A user's explicit minimum always takes precedence.
 *
 * Below / equal ₩50,000, keep the full budget range. Price-only filtering
 * never invents features or relaxes other exclusions.
 */
const NEAR_WON=30000;
const LOW_BUDGET_CEILING=50000;
function targetWindow(c) {
  if (!c || !Number.isFinite(Number(c.budgetSaid))) return null;
  const stated=Math.round(Number(c.budgetSaid));
  if (stated<=LOW_BUDGET_CEILING || stated<=0) return null;
  // An explicit "조금 넘어도 괜찮아" relaxes the previously strict ceiling.
  // Honor that deliberate override rather than imposing the implicit target.
  if (c.budgetRelax === true) return null;
  const max= Math.round(Number(c.budgetMax)||0);
  if (max<=0) return null; // pure minimum ("15만원 이상") has no ceiling
  const explicitMin=Math.max(0,Math.round(Number(c.budgetMin)||0));
  // A relaxed "15만원 정도" permits upper-side prices only when the
  // original budget parser already determined that this is a soft budget.
  const upper= c.budgetSoft ? Math.min(max,stated+NEAR_WON) : Math.min(max,stated);
  const lower=Math.max(explicitMin,stated-NEAR_WON);
  if (upper<lower) return null;
  return { min:lower,max:upper,target:stated };
}
function narrowToTarget(items,c) {
  const range=targetWindow(c);
  if(!range)return { applies:false,within:(items||[]),outside:[],range:null };
  const within=[],outside=[];
  (items||[]).forEach(it=>{
    const p=Math.round(Number(it&&it.price)||0);
    (p>=range.min&&p<=range.max?within:outside).push(it);
  });
  // Price closer to the stated ceiling is the first criterion. Preserve
  // existing relevance / trust ordering as stable tie-breaks.
  within.sort((a,b)=>Math.abs(a.price-range.target)-Math.abs(b.price-range.target));
  return { applies:true,within,outside,range };
}
function rejectGaming(items,c) {
  if (!c || c.avoid!=='게이밍') return {items:items||[],excluded:[]};
  const excluded=[];
  const kept=(items||[]).filter(p=>{
    if (/게이밍|게임용|게이머|gaming|gamer|game\s*headset/i.test(String(p?.title||''))) {
      excluded.push(p);return false;
    }
    return true;
  });
  return {items:kept,excluded};
}
module.exports={NEAR_WON,LOW_BUDGET_CEILING,targetWindow,narrowToTarget,rejectGaming};
