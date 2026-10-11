import { ApiError, userMessage } from './api.ts';
import { isEmail } from './format.ts';

/*
 * Step 1 of e-mail sign-in (app/login.tsx), pure so node tests drive the same path the screen uses.
 *
 * SEOSA has no guardian-consent process, so login is for users aged 14 or over. The server refuses a
 * code request without `ageConfirmed: true` (api/auth.js, PR #118); the web asks with the same
 * required checkbox (public/index.html #authAge). Here an unticked box never reaches the network,
 * and the screen starts unticked every time it opens. Search and prices need no login and no check.
 */

/** The checkbox label, word for word the web's. */
export const AGE_CONFIRM_LABEL = '만 14세 이상입니다 (필수)';
/** The web's helper line under the checkbox. */
export const AGE_CONFIRM_NOTE = '만 14세 미만은 로그인할 수 없어요. 검색과 가격 확인은 로그인 없이 이용할 수 있어요.';
/** Shown when the button is pressed with the box unticked. */
export const AGE_UNCHECKED_MESSAGE = '만 14세 이상인지 확인해 주세요. 만 14세 미만은 로그인할 수 없어요.';
export const EMAIL_INVALID_MESSAGE = '이메일 주소를 확인해 주세요.';

export type CodeRequestInput = { email: string; ageConfirmed: boolean };
export type CodeRequestResult =
  | { ok: true; expiresInSec: number }
  | { ok: false; reason: 'email' | 'age' | 'server'; message: string };

/** What stops a code request before any network call, in the screen's order (e-mail, then age). '' when nothing does. */
export function codeRequestProblem(input: CodeRequestInput): string {
  if (!isEmail(input.email)) return EMAIL_INVALID_MESSAGE;
  if (input.ageConfirmed !== true) return AGE_UNCHECKED_MESSAGE;
  return '';
}

export async function requestLoginCode(
  input: CodeRequestInput,
  requestCode: (email: string, ageConfirmed: true) => Promise<{ expiresInSec: number }>,
): Promise<CodeRequestResult> {
  const problem = codeRequestProblem(input);
  if (problem) return { ok: false, reason: problem === EMAIL_INVALID_MESSAGE ? 'email' : 'age', message: problem };
  try {
    const r = await requestCode(input.email.trim(), true);
    return { ok: true, expiresInSec: r.expiresInSec };
  } catch (error) {
    const age = error instanceof ApiError && error.reason === 'age_confirmation';
    return { ok: false, reason: age ? 'age' : 'server', message: userMessage(error) };
  }
}
