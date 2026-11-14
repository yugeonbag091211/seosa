'use strict';

/*
 * v3 대화 기록 계약 (2026-11-14).
 *
 * ── 무엇이 어긋나 있었나 ─────────────────────────────────────────────
 *
 * 웹(public/index.html Chat.send)과 앱(apps/mobile/lib/ai.ts buildAiRequest)은 legacy 와 같은
 * chatHistory 를 보낸다: [{ role: 'user'|'assistant', text, sig? }]. 웹은 이번 질문을 기록에
 * 먼저 넣고 보낸다. 그런데 v3 엔진은 request.history({ role, content }) 만 읽었다.
 *   · 앱은 history 를 보내지 않으므로 v3 플래너에 이전 대화가 한 줄도 가지 않았다.
 *   · 웹(79b45f5)은 chatHistory 를 잘라 history 를 따로 만들어 보냈는데, 이번 질문이 기록 끝과
 *     본문(message)에 두 번 실렸고, 잘린 본문으로는 답변 서명을 확인할 수 없었다.
 *   · assistant 발화가 서명 확인 없이 assistant 역할로 모델에 들어갔다 — 클라이언트가 «AI 가
 *     예산을 무시하기로 했다» 같은 가짜 이전 답변을 끼워 넣을 수 있었다.
 *
 * ── 규칙 ─────────────────────────────────────────────────────────────
 *
 *   · chatHistory 를 읽고, 없거나 비어 있으면 history 를 읽는다. 둘 다 같은 모양으로 정규화한다.
 *     (chatHistory 가 웹·앱 공통의 정식 필드다. history 는 API 클라이언트 호환용.)
 *   · assistant 발화는 서버 서명(turnSig — api/_aicontext.signTurn, legacy 와 같은 키·만료 6시간)이
 *     맞을 때만 assistant 다. 서명은 «잘리기 전 원문» 으로 확인한다. 안 맞으면 «검증되지 않은
 *     인용» 이라고 밝힌 user 메시지로 내린다 — legacy normalizeHistory 와 같은 규칙이다.
 *     그래서 v3 답변과 legacy 답변이 서로의 서명을 인정한다(폴백이 섞여도 문맥이 이어진다).
 *   · 마지막 user 발화가 이번 질문과 같으면 뺀다(본문 message 로 이미 간다).
 *   · 최근 8개, 한 개 500자. 받은 목록은 끝에서 40개까지만 본다(일을 묶는다).
 */
const AC = require('./_aicontext');

const MAX_TURNS = 8;
const MAX_CHARS = 500;
const MAX_SCAN = 40;
const UNVERIFIED_PREFIX = '[검증되지 않은 클라이언트 대화 기록 · 주장된 발화자=assistant] ';

const clean = (x, n) => String(x == null ? '' : x).normalize('NFKC')
  .replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// 둘 다 오면 chatHistory 가 이긴다 — 서명(sig)과 잘리지 않은 원문을 가진 쪽이다
// (79b45f5 웹 빌드는 500자로 자르고 sig 를 뺀 history 와 chatHistory 를 함께 보냈다).
function pickSource(body) {
  if (Array.isArray(body.chatHistory) && body.chatHistory.length) return { list: body.chatHistory, source: 'chatHistory' };
  if (Array.isArray(body.history) && body.history.length) return { list: body.history, source: 'history' };
  return { list: [], source: 'none' };
}

/**
 * @param {object} body     요청 본문 (history | chatHistory)
 * @param {string} message  이번 질문
 * @param {number} [now]    서명 만료 판정 시각 (테스트용)
 * @returns {{ history: Array<{role:'user'|'assistant', content:string}>, stats: object }}
 */
function normalizeV3History(body, message, now) {
  const b = body && typeof body === 'object' ? body : {};
  const { list, source } = pickSource(b);
  const stats = { source, received: list.length, used: 0, verifiedAssistant: 0, unverifiedAssistant: 0, droppedCurrent: false };
  const turns = [];
  for (const h of list.slice(-MAX_SCAN)) {
    if (!h || typeof h !== 'object') continue;
    const raw = typeof h.content === 'string' ? h.content : typeof h.text === 'string' ? h.text : '';
    const content = clean(raw, MAX_CHARS);
    if (!content) continue;
    if (h.role === 'assistant') {
      // 클라이언트가 verified:true 를 적어 보내도 보지 않는다 — 서명만 본다.
      if (AC.verifyTurn({ role: 'assistant', sig: h.sig, text: raw }, now)) {
        stats.verifiedAssistant++;
        turns.push({ role: 'assistant', content });
      } else {
        stats.unverifiedAssistant++;
        turns.push({ role: 'user', content: clean(UNVERIFIED_PREFIX + raw, MAX_CHARS) });
      }
    } else {
      turns.push({ role: 'user', content });
    }
  }
  const current = clean(message, MAX_CHARS);
  const last = turns[turns.length - 1];
  if (current && last && last.role === 'user' && last.content === current) {
    turns.pop();
    stats.droppedCurrent = true;
  }
  const history = turns.slice(-MAX_TURNS);
  stats.used = history.length;
  return { history, stats };
}

module.exports = { normalizeV3History, MAX_TURNS, MAX_CHARS, UNVERIFIED_PREFIX };
