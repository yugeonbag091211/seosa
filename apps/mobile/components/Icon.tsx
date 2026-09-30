import Svg, { Circle, Path } from 'react-native-svg';

/*
 * Line icons drawn in-house (1.6 stroke on a 24 grid) so the set stays quiet and consistent
 * without shipping an icon font.
 */
export type IconName =
  | 'home' | 'search' | 'trendDown' | 'bookmark' | 'bookmarkFill' | 'person' | 'sparkle'
  | 'chevronRight' | 'chevronLeft' | 'close' | 'clock' | 'external' | 'send';

export function Icon({ name, size = 24, color, strokeWidth = 1.6 }: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  const p = { stroke: color, strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'home' && <Path {...p} d="M3.5 10.5 12 4l8.5 6.5V20a.5.5 0 0 1-.5.5h-5.25v-6h-5.5v6H4a.5.5 0 0 1-.5-.5z" />}
      {name === 'search' && <><Circle {...p} cx={10.5} cy={10.5} r={6} /><Path {...p} d="m15 15 5 5" /></>}
      {name === 'trendDown' && <><Path {...p} d="M3.5 7.5 9.5 13.5l3.5-3.5 7.5 7.5" /><Path {...p} d="M20.5 12.5v5h-5" /></>}
      {name === 'bookmark' && <Path {...p} d="M6.5 4h11a.5.5 0 0 1 .5.5v15.3l-6-4.3-6 4.3V4.5a.5.5 0 0 1 .5-.5z" />}
      {name === 'bookmarkFill' && <Path stroke={color} strokeWidth={strokeWidth} fill={color} strokeLinejoin="round" d="M6.5 4h11a.5.5 0 0 1 .5.5v15.3l-6-4.3-6 4.3V4.5a.5.5 0 0 1 .5-.5z" />}
      {name === 'person' && <><Circle {...p} cx={12} cy={8.5} r={4} /><Path {...p} d="M4.5 20c1.3-3.6 4.2-5.5 7.5-5.5s6.2 1.9 7.5 5.5" /></>}
      {name === 'sparkle' && <Path {...p} d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5zM18.5 15.5c.25 1.5 1 2.25 2.5 2.5-1.5.25-2.25 1-2.5 2.5-.25-1.5-1-2.25-2.5-2.5 1.5-.25 2.25-1 2.5-2.5z" />}
      {name === 'chevronRight' && <Path {...p} d="m9.5 5.5 6.5 6.5-6.5 6.5" />}
      {name === 'chevronLeft' && <Path {...p} d="M14.5 5.5 8 12l6.5 6.5" />}
      {name === 'close' && <Path {...p} d="m6 6 12 12M18 6 6 18" />}
      {name === 'clock' && <><Circle {...p} cx={12} cy={12} r={8} /><Path {...p} d="M12 7.5V12l3 2" /></>}
      {name === 'external' && <><Path {...p} d="M13.5 4.5h6v6" /><Path {...p} d="m19.5 4.5-9 9" /><Path {...p} d="M17.5 13.5v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h5" /></>}
      {name === 'send' && <Path {...p} d="M12 19.5v-15m0 0-6 6m6-6 6 6" />}
    </Svg>
  );
}
