import { ApiError, userMessage } from './api.ts';

/*
 * In-app account deletion (Apple 5.1.1(v)). Pure orchestration so tests can drive every path.
 *
 * Order matters: the server deletes first. Only after it confirms does the device forget
 * everything — the token (SecureStore), every cached response (React Query) and on-device
 * data (saved products, recent searches). If the server did not confirm, nothing local is
 * touched except a token the server just rejected.
 */
export type DeletionDeps = {
  token: () => string | undefined;
  requestDeletion: (token: string) => Promise<unknown>;
  /** Removes the token from secure storage and signs out. Resolves false if the token could not be removed. */
  clearSession: () => Promise<boolean | void>;
  clearCache: () => void;
  clearLocalData: () => Promise<void> | void;
};

export type DeletionResult =
  | { status: 'deleted'; tokenRemoved: boolean }
  | { status: 'needs_login' }
  | { status: 'blocked'; message: string }
  | { status: 'failed'; message: string };

export async function deleteAccountFlow(d: DeletionDeps): Promise<DeletionResult> {
  const token = d.token();
  if (!token) return { status: 'needs_login' };

  try {
    await d.requestDeletion(token);
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'unauthorized') {
      await d.clearSession();
      return { status: 'needs_login' };
    }
    if (error instanceof ApiError && error.status === 409) return { status: 'blocked', message: userMessage(error) };
    return { status: 'failed', message: userMessage(error) };
  }

  // Each step runs even if another throws — a failed cache wipe must not keep the token.
  const [session] = await Promise.allSettled([
    d.clearSession(),
    Promise.resolve().then(() => d.clearCache()),
    Promise.resolve().then(() => d.clearLocalData()),
  ]);
  const tokenRemoved = session.status === 'fulfilled' && session.value !== false;
  return { status: 'deleted', tokenRemoved };
}

/** What the confirmation screen lists — the same tables api/_account.js deletes and keeps. */
export const DELETED_ON_SERVER = ['가격 알림', '찜·기록 동기화', '취향 프로필', 'AI 사용 기록', '구독 정보', '인증 코드'] as const;
export const RETAINED_ON_SERVER = '결제 기록 (전자상거래법에 따라 5년 보관)';
