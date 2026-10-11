'use strict';

const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync('public/index.html', 'utf8');
const ai = fs.readFileSync('api/ai.js', 'utf8');
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

function numberFrom(re, text, label) {
  const m = text.match(re);
  assert(m, `${label} not found`);
  return Number(m[1]);
}

const chatTimeoutMs = numberFrom(/CHAT_TIMEOUT_MS:\s*(\d+)/, html, 'CHAT_TIMEOUT_MS');
const historyWaitMs = numberFrom(/AI_HIST_WAIT_MS:\s*(\d+)/, html, 'AI_HIST_WAIT_MS');
const requestBudgetMs = numberFrom(/REQUEST_BUDGET_MS\s*=\s*(\d+)/, ai, 'REQUEST_BUDGET_MS');

const sendAt = html.indexOf('send: function(preset)');
assert(sendAt >= 0, 'Chat.send not found');
const ensureAt = html.indexOf('Chat.ensureHistory(ctx.items, function()', sendAt);
assert(ensureAt >= 0, 'Chat.ensureHistory call not found inside Chat.send');
const requestAt = html.indexOf("Api.call('askAI'", ensureAt);
assert(requestAt >= 0, 'askAI request not found after history prefetch');
const timerAt = html.indexOf('timer = setTimeout(function()', sendAt);
assert(timerAt >= 0, 'AI response timer not found');

// The 4s optional history prefetch must not consume the response timeout.
assert(timerAt > ensureAt && timerAt < requestAt,
  'AI response timer must start after history prefetch and immediately before askAI');

// Keep enough client-side headroom for cold start, network transit, and JSON parsing.
assert(chatTimeoutMs >= requestBudgetMs + 5000,
  `client timeout needs >=5s headroom: client=${chatTimeoutMs}, backend=${requestBudgetMs}`);

const aiFn = vercel.functions && vercel.functions['api/ai.js'];
assert(aiFn && Number(aiFn.maxDuration) > 0, 'vercel.json must set api/ai.js maxDuration explicitly');
assert(Number(aiFn.maxDuration) * 1000 >= requestBudgetMs + 5000,
  `Vercel maxDuration needs >=5s headroom: max=${aiFn.maxDuration}s, backend=${requestBudgetMs}ms`);

assert(historyWaitMs <= 5000, `history prefetch wait unexpectedly high: ${historyWaitMs}ms`);

console.log(JSON.stringify({
  ok: true,
  chatTimeoutMs,
  historyWaitMs,
  requestBudgetMs,
  vercelMaxDurationSec: Number(aiFn.maxDuration)
}));
