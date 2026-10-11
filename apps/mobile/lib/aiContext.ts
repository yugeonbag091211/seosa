import type { Product } from './types.ts';

/*
 * What the user was looking at when they opened the concierge (the web's Chat.contextItems):
 * the product on screen, or the current search results. Held in memory for one hand-off.
 * The server re-checks every item against its own catalog (api/_aicontext.js).
 */
export type AiScreenContext = { source: 'product' | 'search' | 'saved' | 'none'; keyword: string; products: Product[] };

let current: AiScreenContext = { source: 'none', keyword: '', products: [] };

export function setAiContext(ctx: AiScreenContext) {
  current = { ...ctx, products: ctx.products.slice(0, 8) };
}

export function takeAiContext(): AiScreenContext {
  const c = current;
  current = { source: 'none', keyword: '', products: [] };
  return c;
}
