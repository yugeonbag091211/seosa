import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import type { PricePoint } from '../lib/api';
import { buildChartModel } from '../lib/chart';
import { formatPrice } from '../lib/format';
import { fonts, useTheme } from '../lib/theme';

/* Web modal chart (Chart.js line): y-axis price ticks, faint grid, soft fill, dashed min/avg/max, ringed last point. */
const HEIGHT = 220;
const TOP = 10;
const BOTTOM = 196;
const TICK_FONT = 10;

/** `initialWidth` lets the chart draw on the first frame; onLayout then corrects it to the measured width. */
export function PriceChart({ points, average, initialWidth = 0 }: { points: PricePoint[]; average?: number; initialWidth?: number }) {
  const theme = useTheme();
  const [width, setWidth] = useState(Math.max(0, Math.round(initialWidth)));
  const labelWidth = useMemo(() => {
    const longest = points.reduce((n, p) => Math.max(n, formatPrice(p.price).length), 0);
    return Math.min(64, 8 + longest * 6.2);
  }, [points]);
  const model = useMemo(
    () => buildChartModel(points, width, { top: TOP, bottom: BOTTOM, left: labelWidth, tickCount: 5 }),
    [points, width, labelWidth],
  );

  if (!model) {
    return <Text style={{ fontSize: 13, color: theme.muted, textAlign: 'center', paddingVertical: 40 }}>가격 추이는 데이터가 쌓이면 표시됩니다.</Text>;
  }

  const plotLeft = labelWidth + 6;
  const plotRight = width - 6;
  const yOf = (price: number) => (model.flat ? (TOP + BOTTOM) / 2 : BOTTOM - ((price - model.min) / (model.max - model.min)) * (BOTTOM - TOP));
  const guides = model.flat ? [] : [
    { key: 'min', y: yOf(model.min), color: 'rgba(11,122,75,0.55)', dash: '6,4' },
    ...(average ? [{ key: 'avg', y: yOf(average), color: 'rgba(166,166,158,0.55)', dash: '3,3' }] : []),
    { key: 'max', y: yOf(model.max), color: 'rgba(201,54,43,0.45)', dash: '6,4' },
  ];

  return <View accessible accessibilityRole="image" accessibilityLabel={model.accessibilityLabel}>
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))} style={{ height: HEIGHT }}>
      {width > 0 ? <Svg width={width} height={HEIGHT}>
        <Defs>
          <LinearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={theme.chartFill} />
            <Stop offset="1" stopColor={theme.chartFill} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        {model.ticks.map(tick => <Line key={`g-${tick.value}`} x1={plotLeft} x2={plotRight} y1={tick.y} y2={tick.y} stroke={theme.chartGrid} strokeWidth={1} />)}
        {model.ticks.map(tick => <SvgText key={`t-${tick.value}`} x={labelWidth} y={tick.y + TICK_FONT / 3} fontSize={TICK_FONT} fontFamily={fonts.mono} fill={theme.chartTick} textAnchor="end">{formatPrice(tick.value)}</SvgText>)}
        {model.fillPath ? <Path d={model.fillPath} fill="url(#priceFill)" /> : null}
        {guides.map(g => <Line key={g.key} x1={plotLeft} x2={plotRight} y1={g.y} y2={g.y} stroke={g.color} strokeWidth={1.2} strokeDasharray={g.dash} />)}
        {model.path ? <Path d={model.path} fill="none" stroke={theme.chartLine} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" /> : null}
        <Circle cx={model.last.x} cy={model.last.y} r={5} fill={theme.chartPoint} stroke={theme.chartLast} strokeWidth={2.5} />
      </Svg> : null}
    </View>
    <View importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', justifyContent: model.points.length === 1 ? 'center' : 'space-between', paddingLeft: plotLeft, marginTop: 2 }}>
      <Text style={{ fontSize: TICK_FONT, fontFamily: fonts.mono, color: theme.chartTick }}>{model.firstDate}</Text>
      {model.points.length > 1 ? <Text style={{ fontSize: TICK_FONT, fontFamily: fonts.mono, color: theme.chartTick }}>{model.lastDate}</Text> : null}
    </View>
  </View>;
}
