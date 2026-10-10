import { router, type Href } from 'expo-router';
import { createTapGuard } from './tapGuard';

/** One guard for the whole app (lib/tapGuard.ts): a double tap opens a screen once. */
export const allowTap = createTapGuard();

export function pushOnce(href: Href, key: string = typeof href === 'string' ? href : JSON.stringify(href)): void {
  if (allowTap(key)) router.push(href);
}
