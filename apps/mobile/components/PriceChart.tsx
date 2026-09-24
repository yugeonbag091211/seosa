import { useMemo, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import type { PricePoint } from '../lib/api';
import { buildChartModel, CHART, type GuideKind } from '../lib/chart';
import { useTheme } from '../lib/theme';
import { AppText, useTypeface } from './AppText';

/*
 * Web modal chart (Chart.js line): y-axis price ticks, faint grid, soft fill, ringed last point, and dashed
 * min/avg/max guides — each with its own text label, so they are not told apart by color alone.
 * x is proportional to calendar days (see lib/chart.ts).
 */
const HEIGHT = 220;
const TOP = 10;
const BOTTOM = 196;
const TICK_FONT = 10;
const GUIDE_FONT = 10;

/** `initialWidth` lets the chart draw on the first frame; onLayout then corrects it to the measured width. */
export function PriceChart({ points, average, initialWidth = 0 }: { points: PricePoint[]; average?: number; initialWidth?: number }) {
  const theme = useTheme();
  const typeface = useTypeface();
  const [width, setWidth] = useState(Math.max(0, Math.round(initialWidth)));
  const model = useMemo(
    () => buildChartModel(points, width, {
      height: HEIGHT, top: TOP, bottom: BOTTOM, tickCount: 5, axisFontSize: TICK_FONT, guideFontSize: GUIDE_FONT, average,
    }),
    [points, width, average],
  );

  if (!model) {
    return <AppText style={{ fontSize: 13, color: theme.muted, textAlign: 'center', paddingVertical: 40 }}>가격 추이는 데이터가 쌓이면 표시됩니다.</AppText>;
  }

  const plotLeft = model.left + CHART.side;
  const plotRight = width - CHART.side;
  const guideStyle: Record<GuideKind, { color: string; dash: string }> = {
    max: { color: theme.warning, dash: '6,4' },
    avg: { color: theme.muted, dash: '2,3' },
    min: { color: theme.positive, dash: '6,4' },
  };
  const guideFamily = typeface.body('600');

  return <View accessible accessibilityRole="image" accessibilityLabel={model.accessibilityLabel}>
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))} style={{ height: HEIGHT }}>
      {width > 0 ? <Svg width={width} height={HEIGHT}>
        <Defs>
          <LinearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={theme.chartFill} />
            <Stop offset="1" stopColor={theme.chartFill} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        {model.ticks.map((tick, i) => <Line key={`g-${i}`} x1={plotLeft} x2={plotRight} y1={tick.y} y2={tick.y} stroke={theme.chartGrid} strokeWidth={1} />)}
        {model.ticks.map((tick, i) => <SvgText key={`t-${i}`} x={model.left - 4} y={tick.y + TICK_FONT / 3} fontSize={TICK_FONT}
          fontFamily={typeface.mono} fill={theme.chartTick} textAnchor="end">{tick.label}</SvgText>)}
        {model.fillPath ? <Path d={model.fillPath} fill="url(#priceFill)" /> : null}
        {model.guides.map(g => <Line key={`l-${g.kind}`} x1={plotLeft} x2={plotRight} y1={g.y} y2={g.y}
          stroke={guideStyle[g.kind].color} strokeOpacity={0.55} strokeWidth={1.2} strokeDasharray={guideStyle[g.kind].dash} />)}
        {model.path ? <Path d={model.path} fill="none" stroke={theme.chartLine} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" /> : null}
        <Circle cx={model.last.x} cy={model.last.y} r={5} fill={theme.chartPoint} stroke={theme.chartLast} strokeWidth={2.5} />
        {model.guides.map(g => {
          const x = g.anchor === 'start' ? plotLeft + 2 : plotRight - 2 - g.labelWidth;
          return <Rect key={`p-${g.kind}`} x={x} y={g.labelY - g.labelHeight / 2} width={g.labelWidth} height={g.labelHeight} rx={3}
            fill={theme.background} fillOpacity={0.9} stroke={guideStyle[g.kind].color} strokeOpacity={0.35} strokeWidth={1} />;
        })}
        {model.guides.map(g => {
          const x = g.anchor === 'start' ? plotLeft + 5 : plotRight - 5;
          return <SvgText key={`n-${g.kind}`} x={x} y={g.labelY + GUIDE_FONT * 0.36} fontSize={GUIDE_FONT}
            fontFamily={guideFamily} fontWeight={guideFamily ? undefined : '600'} fill={guideStyle[g.kind].color}
            textAnchor={g.anchor}>{g.label}</SvgText>;
        })}
      </Svg> : null}
    </View>
    <View importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', justifyContent: model.points.length === 1 ? 'center' : 'space-between', flexWrap: 'wrap', paddingLeft: plotLeft, marginTop: 2 }}>
      <AppText style={{ fontSize: TICK_FONT, fontFamily: typeface.mono, color: theme.chartTick }}>{model.firstDate}</AppText>
      {model.points.length > 1 ? <AppText style={{ fontSize: TICK_FONT, fontFamily: typeface.mono, color: theme.chartTick }}>{model.lastDate}</AppText> : null}
    </View>
  </View>;
}
