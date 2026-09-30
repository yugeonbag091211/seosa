import type { Deal } from './types.ts';

/*
 * Whether the detail screen may show the server's verdict — the web's Modal.renderVerdict rule
 * (public/index.html): with fewer than two recorded days there is no trend to judge, so it says
 * the history is still being collected instead. Carried over from the PR #34 prototype.
 */
export type VerdictView = { kind: 'collecting' } | { kind: 'deal'; deal: Deal } | null;

export function verdictView(pointCount: number, deal: Deal | null): VerdictView {
  if (pointCount < 2) return { kind: 'collecting' };
  return deal && deal.verdict ? { kind: 'deal', deal } : null;
}
