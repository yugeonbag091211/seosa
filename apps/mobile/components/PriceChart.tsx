import { useMemo, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import type { PricePoint } from '../lib/api';
import { buildChartModel, CHART, formatWon } from '../lib/chart';
import { useTheme } from '../lib/theme';
import { Text } from './ui';

const label = { fontSize: 12, lineHeight: 17, flexShrink: 1 } as const;

/** Minimal sparkline: two guide lines, the price path, and a dot on the latest observation. */
export function PriceChart({ points }: { points: PricePoint[] }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const model = useMemo(() => buildChartModel(points, width), [points, width]);

  if (!model) {
    return <Text muted>아직 관측된 가격 기록이 없어요.</Text>;
  }

  const single = model.points.length === 1;
  return <View accessible accessibilityRole="image" accessibilityLabel={model.accessibilityLabel} style={{ gap: 8 }}>
    <View importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      {model.flat
        ? <Text muted style={label}>{single ? '관측 가격' : '변동 없음'} {formatWon(model.latest)}</Text>
        : <>
          <Text muted style={label}>최저 {formatWon(model.min)}</Text>
          <Text muted style={[label, { textAlign: 'right' }]}>최고 {formatWon(model.max)}</Text>
        </>}
    </View>
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))} style={{ height: CHART.height }}>
      {width > 0 ? <Svg width={width} height={CHART.height} viewBox={`0 0 ${width} ${CHART.height}`}>
        <Line x1={CHART.side} y1={CHART.top} x2={width - CHART.side} y2={CHART.top} stroke={theme.border} strokeWidth={1} />
        <Line x1={CHART.side} y1={CHART.bottom} x2={width - CHART.side} y2={CHART.bottom} stroke={theme.border} strokeWidth={1} />
        {model.path ? <Path d={model.path} fill="none" stroke={theme.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /> : null}
        <Circle cx={model.last.x} cy={model.last.y} r={4} fill={theme.text} />
      </Svg> : null}
    </View>
    <View importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', justifyContent: single ? 'center' : 'space-between', gap: 12 }}>
      <Text muted style={label}>{model.firstDate}</Text>
      {single ? null : <Text muted style={[label, { textAlign: 'right' }]}>{model.lastDate}</Text>}
    </View>
  </View>;
}
