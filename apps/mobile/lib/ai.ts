import type { AiTurn, Product } from './types.ts';

/*
 * Request body for POST /api/ai.
 *
 * The server treats everything the client sends as untrusted (api/_aicontext.js, red-team
 * RT-01..03): product prices, discounts and history in the body are ignored, and a product is
 * only used once productId + mall + vendorItemId match SEOSA's own catalog. So the app sends
 * selectors only — it has no price to add that the server would accept, and sending one would
 * suggest otherwise.
 *
 * Past assistant turns are only accepted when they carry the server's signature (turnSig →
 * `sig`), and the previous top pick only through the server-signed topRecommendationRef.
 * Both are passed back unmodified.
 */

/** api/_aicontext.MAX_SELECTORS */
export const MAX_CONTEXT_PRODUCTS = 8;
/** The web's CONST.LIMIT.CHAT_HISTORY */
export const MAX_HISTORY = 10;
/** api/ai.js MAX_QUESTION_LEN is enforced server-side; the input box stops earlier. */
export const MAX_QUESTION = 300;

export type AiContextSelector = {
  ref: string;
  productId: string;
  vendorItemId: string;
  /** Backend mall id ('쿠팡' | 'ADPICK') — what the server matches on. */
  mallId: string;
  /** Display name, only used by the server when the product cannot be verified. */
  mall: string;
  title: string;
};

export function contextSelectors(products: readonly Product[]): AiContextSelector[] {
  const seen = new Set<string>();
  const out: AiContextSelector[] = [];
  for (const p of products) {
    if (!p || !p.productId) continue;
    const key = `${p.productId}|${p.mall}|${p.vendorItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ref: `P${out.length + 1}`,
      productId: p.productId,
      vendorItemId: p.vendorItemId || '',
      mallId: p.mall,
      mall: p.mallLabel || p.mall,
      title: p.title.slice(0, 120),
    });
    if (out.length >= MAX_CONTEXT_PRODUCTS) break;
  }
  return out;
}

/** Keeps the last MAX_HISTORY turns; assistant turns keep their signature exactly as received. */
export function trimHistory(history: readonly AiTurn[]): AiTurn[] {
  return history.slice(-MAX_HISTORY).map(t => (t.role === 'assistant'
    ? (t.sig ? { role: 'assistant', text: t.text, sig: t.sig } : { role: 'assistant', text: t.text })
    : { role: 'user', text: t.text }));
}

export type AiRequestInput = {
  question: string;
  context: readonly Product[];
  history: readonly AiTurn[];
  prevTopProductId?: string;
  prevTopRef?: string;
  /** What the user is looking at, like the web's `view`. */
  view?: { source: string; keyword?: string };
};

export function buildAiRequest(input: AiRequestInput) {
  return {
    question: input.question.trim().slice(0, MAX_QUESTION),
    contextProducts: contextSelectors(input.context),
    chatHistory: trimHistory(input.history),
    view: input.view || { source: 'app' },
    prevTop: input.prevTopProductId || '',
    prevTopRef: input.prevTopRef || '',
  };
}
