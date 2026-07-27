const { readBody } = require('./_http');

const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-5';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원' });
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY 환경변수 없음', text: '' });
  }

  const { question, contextProducts, chatHistory, profile } = readBody(req);
  if (!question) return res.status(400).json({ error: '질문 없음', text: '' });

  try {
    // 프론트가 옛날 방식으로 JSON 문자열을 보낼 수도 있으니 방어적으로 파싱한다.
    let ctx = contextProducts;
    if (typeof ctx === 'string') {
      try { ctx = JSON.parse(ctx); } catch (e) { ctx = []; }
    }
    if (!Array.isArray(ctx)) ctx = [];
    const products = ctx.slice(0, 8)
      .map(p => `- ${p.title} / ${p.lprice || p.price}원 / ${p.mall || ''}`).join('\n');

    let system = '너는 한국 쇼핑 도우미야. 사용자가 보고 있는 상품 목록을 바탕으로 '
      + '가격 비교와 구매 시점을 중심으로 3~5문장의 간결한 한국어 조언을 해.';
    if (profile) system += `\n\n사용자 프로필: ${JSON.stringify(profile)}`;
    if (products) system += `\n\n현재 상품 목록:\n${products}`;

    const messages = [{ role: 'system', content: system }];
    (chatHistory || []).slice(-6).forEach(h => {
      messages.push({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.text || h.content || ''
      });
    });
    messages.push({ role: 'user', content: question });

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 700 })
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 200)}`);

    const data = await r.json();
    const text = (((data.choices || [])[0] || {}).message || {}).content || '';
    res.json({ text });
  } catch (e) {
    console.error('[ai]', e.message);
    res.status(500).json({ error: e.message, text: '답변을 생성하지 못했어요.' });
  }
};
