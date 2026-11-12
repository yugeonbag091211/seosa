'use strict';

// userId must come from verified server-side authentication, never request JSON.
// Search text is deliberately not persisted: recentSearches contains only
// canonical shopping categories, which cannot accidentally retain personal data.
const { canonicalName } = require('./_ai-v31-taxonomy');
const { brandOfWord } = require('./_ai-v32-brands');
const cleanId = id => typeof id === 'string' && /^[a-f0-9]{64}$/i.test(id) ? id : '';
const num = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const list = v => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 20) : [];
function readRow(row) {
  if (!row) return null;
  return { userId:row.user_id, preferredBrands:list(row.preferred_brands),
    budgetRange:{ min:num(row.budget_min), max:num(row.budget_max) },
    categoryInterests:list(row.category_interests), recentSearches:list(row.recent_searches),
    createdAt:row.created_at, updatedAt:row.updated_at };
}
async function bounded(promise, timeoutMs) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function loadProfile(userId, { db, timeoutMs = 350 } = {}) {
  if (!cleanId(userId)) return null;
  try {
    const source = db || require('./_supabase');
    const response = await bounded(source.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(), timeoutMs);
    return response && !response.error ? readRow(response.data) : null;
  } catch (_) { return null; }
}
function applyProfile(profile, plan) {
  if (!profile || !plan || plan.mode === 'none') return plan;
  const out = { ...plan, preferredBrands:list(profile.preferredBrands) };
  if (out.minPrice == null && out.maxPrice == null) {
    const min = num(profile.budgetRange && profile.budgetRange.min);
    const max = num(profile.budgetRange && profile.budgetRange.max);
    if (min && max && min > max) return out;
    if (min) out.minPrice = min;
    if (max) out.maxPrice = max;
    if (min || max) out.budgetSource = 'profile';
  }
  return out;
}
async function updateProfile(userId, conversationData, { db, timeoutMs = 350 } = {}) {
  if (!cleanId(userId) || process.env.SEOSA_DB_READONLY === '1') return false;
  const data = conversationData || {};
  const brand = brandOfWord(String(data.brandTerm || '')) || '';
  const category = canonicalName(data.category || '') || '';
  const min = num(data.minPrice), max = num(data.maxPrice);
  // Only persist bounds explicitly supplied on this turn, never inferred defaults.
  const budget = data.explicitBudget === true && !(min && max && min > max);
  if (!brand && !category && !budget) return false;
  try {
    const source = db || require('./_supabase');
    const result = await bounded(source.rpc('merge_ai_v3_user_profile', {
      p_user_id:userId, p_brand:brand || null, p_category:category || null,
      p_budget_min:budget ? min : null, p_budget_max:budget ? max : null
    }), timeoutMs);
    return !!result && !result.error;
  } catch (_) { return false; }
}
module.exports = { loadProfile, updateProfile, applyProfile };
