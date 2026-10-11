/*
 * AI answer text → lines and list items with **bold** spans, the same rules as the web's
 * Chat.fmtText. Pure; the screen renders the structure with Text, so nothing is ever
 * interpreted as markup.
 */
export type Span = { text: string; bold: boolean };
export type Block = { kind: 'line' | 'item'; spans: Span[] };

function spans(line: string): Span[] {
  const out: Span[] = [];
  const re = /\*\*([^*\n]{1,120})\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), bold: false });
  return out;
}

export function formatAiText(text: string): Block[] {
  return String(text ?? '').split('\n').map(line => {
    const item = /^\s*[-*•]\s+(.*)$/.exec(line);
    return item ? { kind: 'item' as const, spans: spans(item[1]) } : { kind: 'line' as const, spans: spans(line) };
  });
}
