import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import type { PricePoint } from '../lib/api';
import { useTheme } from '../lib/theme';
import { Text } from './ui';

const HEIGHT = 132;
const TOP = 12;
const BOTTOM = HEIGHT - 12;
const SIDE = 6;

function won(price: number) {
  return `${price.toLocaleString('ko-KR')}원`;
}

/** The API already returns one observation per day in ascending date order. */
export function PriceChart({ points }: { points: PricePoint[] }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const recent = points.slice(-30).filter(point => Number.isFinite(point.price));

  if (recent.length === 0) {
    return <Text muted>아직 관측된 가격 기록이 없어요.</Text>;
  }

  const prices = recent.map(point => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min;
  const position = (point: PricePoint, index: number) => ({
    x: recent.length === 1 ? width / 2 : SIDE + (index / (recent.length - 1)) * (width - SIDE * 2),
    y: span === 0 ? (TOP + BOTTOM) / 2 : BOTTOM - ((point.price - min) / span) * (BOTTOM - TOP),
  });
  const path = recent.map((point, index) => {
    const { x, y } = position(point, index);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const last = position(recent[recent.length - 1], recent.length - 1);
  const firstDate = recent[0].date;
  const lastDate = recent[recent.length - 1].date;
  const accessibilityLabel = `최근 ${recent.length}개 관측일 가격 추이. ${firstDate}부터 ${lastDate}까지. 최저 ${won(min)}, 최고 ${won(max)}, 최근 ${won(recent[recent.length - 1].price)}.`;

  return <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel} style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text muted style={{ fontSize: 12 }}>최저 {won(min)}</Text>
      <Text muted style={{ fontSize: 12 }}>최고 {won(max)}</Text>
    </View>
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))} style={{ height: HEIGHT }}>
      {width > 0 ? <Svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}>
        <Line x1={SIDE} y1={TOP} x2={width - SIDE} y2={TOP} stroke={theme.border} strokeWidth={1} />
        <Line x1={SIDE} y1={BOTTOM} x2={width - SIDE} y2={BOTTOM} stroke={theme.border} strokeWidth={1} />
        {recent.length > 1 ? <Path d={path} fill="none" stroke={theme.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /> : null}
        <Circle cx={last.x} cy={last.y} r={4} fill={theme.text} />
      </Svg> : null}
    </View>
    <View style={{ flexDirection: 'row', justifyContent: recent.length === 1 ? 'center' : 'space-between' }}>
      <Text muted style={{ fontSize: 12 }}>{firstDate}</Text>
      {recent.length > 1 ? <Text muted style={{ fontSize: 12 }}>{lastDate}</Text> : null}
    </View>
  </View>;
}
