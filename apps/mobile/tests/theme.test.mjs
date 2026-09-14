import assert from 'node:assert/strict';
import test from 'node:test';
import { palette } from '../lib/palette.ts';

/** WCAG 2.x relative luminance / contrast ratio, from the spec formula. */
function relativeLuminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const channel = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [channel((n >> 16) & 255), channel((n >> 8) & 255), channel(n & 255)];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const [a, b] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

test('chart axis/date labels (chartTick) meet 4.5:1 against the chart backgrounds in both themes', () => {
  for (const mode of ['light', 'dark']) {
    const theme = palette[mode];
    for (const bg of [theme.background, theme.surface, theme.card]) {
      assert(contrastRatio(theme.chartTick, bg) >= 4.5,
        `${mode} chartTick ${theme.chartTick} on ${bg} is only ${contrastRatio(theme.chartTick, bg).toFixed(2)}:1`);
    }
  }
});
