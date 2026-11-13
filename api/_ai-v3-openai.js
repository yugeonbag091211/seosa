'use strict';
const { CLASSIFY_SYSTEM, CLASSIFY_SCHEMA } = require('./_ai-v3-classify');

// OpenAI Responses API. One strict function-call plan followed by a structured ID choice.
// No model-generated product titles, links or prices are ever returned to customers.
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['recommend','compare','none'] },
    query: { type: 'string', description: 'Short shopping keyword preserving the named product or model; empty only if there is no shopping request' },
    compareQuery: { type: 'string', description: 'Second product keyword for comparisons; otherwise empty' },
    category: { type: 'string', description: 'Product type, e.g. 노트북, 태블릿, 이어폰' },
    maxPrice: { type: ['integer','null'], description: 'Maximum TOTAL Korean won including delivery, or null' },
    exclusions: { type: 'array', items: { type: 'string' } },
    mallOnly: { type: 'string', description: 'Required merchant, or empty if none' },
    exactModel: { type: 'string', description: 'Exact model name explicitly said by the user, or empty' }
  },
  required: ['mode','query','compareQuery','category','maxPrice','exclusions','mallOnly','exactModel']
};
const DECIDE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { productIds: { type: 'array', items: { type: 'string' }, description: '0 to 4 IDs copied exactly from the supplied candidate list; none if unsuitable' } },
  required: ['productIds']
};
const INSTRUCTIONS = [
  '너는 서사의 쇼핑 검색 담당이다. search_products 도구를 반드시 한 번 사용한다.',
  '사용자의 실제 상품 종류, 예산, 비교 대상, 판매처 및 이전 대화의 조건을 정확하게 유지한다.',
  '질문에서 상품명에 해당하지 않는 상황 설명, 감정, 요청 표현은 검색어에 포함하지 않는다.',
  '사용자가 이름을 말하지 않은 모델명이나 구체적 제품을 지어내지 않는다.',
  '후속 질문이면 state.lastQuery와 대화 기록을 참고하되 새로 명시된 조건이 우선한다.',
  '예산은 배송비 포함 최대 금액이다. 비교라면 각 제품명으로 별도 검색한다.',
  '상품에 관한 불충분한 질문이면 비어 있는 query 또는 category를 전달한다.'
].join('\n');
function makeOpenAiAdapter({ apiKey = process.env.OPENAI_API_KEY, model = process.env.AI_V3_MODEL, fetchImpl = fetch } = {}) {
  if (!apiKey || !model) throw new Error('AI v3 requires OPENAI_API_KEY and AI_V3_MODEL');
  const usage = { model, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const post = async payload => {
    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, store: false, max_output_tokens: 900, ...payload }),
      signal: AbortSignal.timeout(24000)
    });
    if (!res.ok) throw new Error('Model request failed (HTTP ' + res.status + ')');
    const body = await res.json();
    if (body.status && body.status !== 'completed') throw new Error('Incomplete model response');
    const count = v => Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0;
    usage.calls++;
    usage.inputTokens += count(body.usage && body.usage.input_tokens);
    usage.outputTokens += count(body.usage && body.usage.output_tokens);
    usage.totalTokens += count(body.usage && body.usage.total_tokens);
    return body;
  };
  let context;
  return {
    getUsage: () => ({ ...usage }),
    async classifyModel({ message, prior }) {
      const response = await post({
        instructions: CLASSIFY_SYSTEM,
        input: [{ role: 'user', content: JSON.stringify({ message, prior }) }],
        max_output_tokens: 80,
        text: { format: { type: 'json_schema', name: 'seosa_intent', strict: true,
          schema: CLASSIFY_SCHEMA } }
      });
      const content = (response.output || []).flatMap(x => x && x.type === 'message' ? (x.content || []) : [])
        .filter(x => x.type === 'output_text').map(x => x.text).join('');
      return JSON.parse(content);
    },
    async chatResponse(message) {
      const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, store: false, max_tokens: 300, temperature: 0.7,
          messages: [
            { role: 'system', content: 'You are a friendly Korean shopping assistant. The user asked a general question. Answer briefly and naturally in Korean, then gently remind them you can help find products.' },
            { role: 'user', content: message }
          ] }),
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) throw new Error('Chat request failed (HTTP ' + res.status + ')');
      const body = await res.json();
      const answer = body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('Empty chat response');
      const count = v => Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0;
      usage.calls++;
      usage.inputTokens += count(body.usage && body.usage.prompt_tokens);
      usage.outputTokens += count(body.usage && body.usage.completion_tokens);
      usage.totalTokens += count(body.usage && body.usage.total_tokens);
      return answer.trim();
    },
    async planModel({ message, history, state }) {
      const input = [
        ...history.map(x => ({ role: x.role, content: x.content })),
        { role: 'user', content: message + '\n[이전 쇼핑 조건: ' + JSON.stringify(state) + ']' }
      ];
      const first = await post({
        instructions: INSTRUCTIONS,
        input,
        tools: [{ type: 'function', name: 'search_products', strict: true,
          description: 'Search the verified shop catalog by structured product constraints', parameters: PLAN_SCHEMA }],
        tool_choice: { type: 'function', name: 'search_products' },
        parallel_tool_calls: false
      });
      const call = (first.output || []).find(x => x && x.type === 'function_call' && x.name === 'search_products');
      if (!call || !call.call_id) throw new Error('Model did not call search_products');
      let args;
      try { args = JSON.parse(call.arguments); } catch { throw new Error('Invalid tool arguments'); }
      context = { input, output: first.output, call_id: call.call_id };
      return args;
    },
    async decideModel({ plan, candidates }) {
      if (!context) throw new Error('Missing function-call context');
      const output = candidates.map(x => ({
        id: x.id, title: x.title, price: x.price, mall: x.mall, shippingFee: x.shipping,
        category: x.category, source: x.source
      }));
      const response = await post({
        instructions: '서사에서 실제 검색·검증한 상품만 선택한다. 후보 상품 ID 중 최대 4개를 정확하게 복사하라. 사용자 조건과 일치하지 않으면 빈 배열을 출력하라. 상품명, 가격, 링크를 생성하지 마라.',
        input: [...context.input, ...context.output,
          { type: 'function_call_output', call_id: context.call_id, output: JSON.stringify({ plan, items: output }) }],
        tool_choice: 'none',
        text: { format: { type: 'json_schema', name: 'seosa_v3_selection', strict: true, schema: DECIDE_SCHEMA } }
      });
      const content = (response.output || []).flatMap(x => x && x.type === 'message' ? (x.content || []) : [])
        .filter(x => x.type === 'output_text').map(x => x.text).join('');
      if (!content) throw new Error('No model selection');
      try { return JSON.parse(content); } catch { throw new Error('Invalid model selection'); }
    }
  };
}
module.exports = { makeOpenAiAdapter, PLAN_SCHEMA, DECIDE_SCHEMA };
