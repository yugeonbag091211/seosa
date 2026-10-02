import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { availableRanges, buildChart, defaultRange, nearestIndex, withinRange, type ChartRange } from '../lib/chart';
import { digits, observedLabel, shortDate } from '../lib/format';
import { radius, space, type as t, useTheme } from '../lib/theme';
import type { PricePoint } from '../lib/types';
import { AppText, useFontsReady } from './AppText';

const HEIGHT = 180;
const PAD = { top: 16, bottom: 22, left: 0, right: 64 };
const RANGE_LABEL: Record<ChartRange, string> = { 7: '1주', 30: '1개월', 90: '3개월', 365: '1년' };

/**
 * Price history chart.
 *
 * Touch and drag anywhere on the chart: the readout above follows the finger and snaps to a
 * real observation (date + price as recorded), so what the user reads is always a value the
 * server holds. Releasing returns the readout to the latest point.
 */
export function PriceChart({ points }: { points: PricePoint[] }) {
  const theme = useTheme();
  const fontsReady = useFontsReady();
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<ChartRange | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const ranges = useMemo(() => availableRanges(points), [points]);
  // A pick survives a refetch only while it is still offered; otherwise the default for these points.
  const range: ChartRange = picked && ranges.includes(picked) ? picked : defaultRange(points);

  const shown = useMemo(() => withinRange(points, range), [points, range]);
  const model = useMemo(() => buildChart(shown, width, HEIGHT, PAD), [shown, width]);

  if (!points.length) return null;

  const idx = active ?? (model ? model.points.length - 1 : 0);
  const sel = model?.points[idx];

  const track = (e: GestureResponderEvent) => { if (model) setActive(nearestIndex(model, e.nativeEvent.locationX)); };

  return (
    <View>
      <View style={styles.readout} accessibilityLiveRegion="polite">
        {sel ? (
          <>
            <AppText style={t.headline}>{digits(sel.price)}원</AppText>
            <AppText tone="faint" style={t.footnote}>{active === null ? `최근 기록 · ${observedLabel(sel.date)}` : observedLabel(sel.date)}</AppText>
          </>
        ) : null}
      </View>

      <View
        style={{ height: HEIGHT }}
        onLayout={e => setWidth(Math.round(e.nativeEvent.layout.width))}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={track}
        onResponderMove={track}
        onResponderRelease={() => setActive(null)}
        onResponderTerminate={() => setActive(null)}
        onResponderTerminationRequest={() => false}
        accessible
        accessibilityRole="image"
        accessibilityLabel={model ? `가격 그래프, ${RANGE_LABEL[range]}. 최저 ${digits(model.min)}원, 최고 ${digits(model.max)}원.` : '가격 그래프'}
      >
        {model ? (
          <Svg width={width} height={HEIGHT}>
            {model.ticks.map(tk => (
              <Line key={`g${tk.value}`} x1={0} x2={width - PAD.right + 8} y1={tk.y} y2={tk.y} stroke={theme.line} strokeWidth={1} strokeDasharray="3 4" />
            ))}
            {model.ticks.map(tk => (
              <SvgText key={`l${tk.value}`} x={width - PAD.right + 14} y={tk.y + 4} fontSize={11} fill={theme.faint} fontFamily={fontsReady ? 'IBMPlexMono-Regular' : undefined}>
                {digits(tk.value)}
              </SvgText>
            ))}
            <Path d={model.area} fill={theme.chartFill} />
            <Path d={model.path} stroke={theme.chartLine} strokeWidth={2} fill="none" strokeLinejoin="round" />
            {sel ? (
              <>
                {active !== null ? <Line x1={sel.x} x2={sel.x} y1={PAD.top - 8} y2={HEIGHT - PAD.bottom} stroke={theme.line2} strokeWidth={1} /> : null}
                <Circle cx={sel.x} cy={sel.y} r={4.5} fill={theme.bg} stroke={theme.chartLine} strokeWidth={2} />
              </>
            ) : null}
            <SvgText x={0} y={HEIGHT - 4} fontSize={11} fill={theme.faint}>{shortDate(model.points[0].date)}</SvgText>
            <SvgText x={width - PAD.right} y={HEIGHT - 4} fontSize={11} fill={theme.faint} textAnchor="end">
              {shortDate(model.points[model.points.length - 1].date)}
            </SvgText>
          </Svg>
        ) : null}
      </View>

      {ranges.length > 1 ? (
        <View style={[styles.tabs, { backgroundColor: theme.surface }]} accessibilityRole="tablist">
          {ranges.map(r => {
            const on = r === range;
            return (
              <Pressable
                key={r}
                onPress={() => { setPicked(r); setActive(null); }}
                style={[styles.tab, on && { backgroundColor: theme.bg }]}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
              >
                <AppText style={[t.footnote, { fontWeight: on ? '600' : '400', color: on ? theme.ink : theme.soft }]}>{RANGE_LABEL[r]}</AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  readout: { minHeight: 44, marginBottom: space.sm },
  tabs: { flexDirection: 'row', borderRadius: radius.md, padding: 2, marginTop: space.md },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: radius.md - 2 },
});
