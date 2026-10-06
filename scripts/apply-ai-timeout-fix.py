from pathlib import Path
import json

p = Path('public/index.html')
s = p.read_text(encoding='utf-8')

old = '  CHAT_TIMEOUT_MS: 30000,'
new = '  CHAT_TIMEOUT_MS: 35000,'
assert s.count(old) == 1, f'CHAT_TIMEOUT_MS match count={s.count(old)}'
s = s.replace(old, new, 1)

old_timer = """    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      Chat.setSending(false);
      if (typing && typing.parentNode) typing.remove();
      Chat.bubble('응답이 너무 오래 걸려요. 다시 시도해 주세요.', 'ai');
    }, CONST.CHAT_TIMEOUT_MS);
"""
assert s.count(old_timer) == 1, f'timer block match count={s.count(old_timer)}'
s = s.replace(old_timer, '    var timer = null;\n', 1)

prefix = """    Chat.ensureHistory(ctx.items, function() {
      if (settled) return;   // 이력 기다리는 사이 타임아웃이 났다

"""
assert s.count(prefix) == 1, f'ensureHistory prefix match count={s.count(prefix)}'
inserted = """    Chat.ensureHistory(ctx.items, function() {
      if (settled) return;

      // 가격 이력 조회는 선택적 사전 준비다. 이 4초를 AI의 응답 제한에
      // 포함하면 서버의 27초 예산과 합쳐 30초 프론트 제한을 넘을 수 있다.
      // 실제 /api/ai 요청을 보내는 순간부터 응답 타이머를 센다.
      timer = setTimeout(function() {
        if (settled) return;
        settled = true;
        Chat.setSending(false);
        if (typing && typing.parentNode) typing.remove();
        Chat.bubble('응답이 너무 오래 걸려요. 다시 시도해 주세요.', 'ai');
      }, CONST.CHAT_TIMEOUT_MS);

"""
s = s.replace(prefix, inserted, 1)
p.write_text(s, encoding='utf-8')

vp = Path('vercel.json')
cfg = json.loads(vp.read_text(encoding='utf-8'))
funcs = cfg.setdefault('functions', {})
funcs['api/ai.js'] = {'maxDuration': 40}
vp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
