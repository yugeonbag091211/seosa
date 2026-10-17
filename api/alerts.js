const supabase = require('./_supabase');
const { readBody, dbError, applyCors, readEmail, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { safeBuyLink } = require('./_affiliate');
const { requireAuth } = require('./_auth');
const { cleanVendorItemId } = require('./_alertidentity');

const MAX_TITLE_LEN = 300;
const MAX_ALERTS_PER_EMAIL = 100;

function missingColumn(error, name) {
  const message = String(error && error.message || '');
  return message.includes(name) && /column|schema cache|does not exist/i.test(message);
}

async function selectAlerts(email, columns) {
  return supabase
    .from('alerts')
    .select(columns)
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(MAX_ALERTS_PER_EMAIL);
}

module.exports = async function handler(req, res) {
  // 개인 데이터라 Access-Control-Allow-Origin: * 를 붙이지 않는다.
  if (!applyCors(req, res, 'private')) return;
  noStore(res);   // 개인 데이터 — 중간 캐시에 남으면 안 된다

  if (!guard(req, res, { name: 'alerts', limit: 40, windowMs: 60 * 1000 })) return;

  try {
    if (req.method === 'GET') {
      const email = readEmail(req.query && req.query.email);
      if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });
      // 남의 이메일로 조회하면 그 사람이 무엇을 사려는지가 그대로 보인다.
      if (!requireAuth(req, res, email)) return;

      /*
       * on_deal 과 vendor_item_id 는 각각 후속 마이그레이션에서 추가된다.
       * 배포 순서가 뒤집혀도 기존 웹 목록은 살아 있어야 한다. 단, 옵션 식별자를
       * 보낸 새 알림은 POST 에서 fail-closed 하므로 이 GET 폴백이 안전성을 낮추지 않는다.
       */
      const BASE = 'title, target_price, current_price, link, image, mall, sent, product_id';
      let vendorSupported = true;
      let onDealSupported = true;
      let { data, error } = await selectAlerts(email, `${BASE}, on_deal, vendor_item_id`);

      if (missingColumn(error, 'vendor_item_id')) {
        vendorSupported = false;
        console.warn('[alerts] vendor_item_id 컬럼 없음 — 옵션 단위 알림은 아직 사용할 수 없습니다.');
        ({ data, error } = await selectAlerts(email, `${BASE}, on_deal`));
      }

      if (missingColumn(error, 'on_deal')) {
        onDealSupported = false;
        console.warn('[alerts] on_deal 컬럼 없음 — supabase/2026-08-28-alert-on-deal.sql을 실행하세요.');
        ({ data, error } = await selectAlerts(email, vendorSupported ? `${BASE}, vendor_item_id` : BASE));
      }

      const msg = dbError(error, 'alerts');
      if (msg) throw new Error(msg);

      return res.json((data || []).map(a => ({
        title: a.title,
        targetPrice: a.target_price,
        currentPrice: a.current_price,
        link: safeBuyLink(a.link),
        image: a.image || '',
        mall: a.mall || '',
        productId: a.product_id || '',
        vendorItemId: vendorSupported ? cleanVendorItemId(a.vendor_item_id) : '',
        sent: a.sent ? 'Y' : 'N',
        onDeal: onDealSupported ? !!a.on_deal : false
      })));
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      const email = readEmail(body.email);
      const title = String(body.title || '').trim().slice(0, MAX_TITLE_LEN);

      if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });
      if (!title) return res.status(400).json({ error: '상품명 없음' });
      // 인증 없이 열어두면 아무 주소로나 알림 메일을 보내게 만들 수 있다.
      if (!requireAuth(req, res, email)) return;

      const targetPrice = parseInt(body.targetPrice, 10) || 0;
      const currentPrice = parseInt(body.currentPrice, 10) || 0;
      const productId = String(body.productId || '').trim().slice(0, 100);
      const vendorItemId = cleanVendorItemId(body.vendorItemId);

      /*
       * 조건이 하나라도 있어야 한다.
       *
       * 예전에는 목표가만 조건이라 목표가가 없으면 신청 자체가 무의미했다.
       * 이제 "AI 가 사도 좋다고 하면 알려줘"(on_deal)도 조건이므로, 목표가를
       * 몰라도 신청할 수 있다. 다만 둘 다 없으면 아무 때도 발송되지 않는
       * 알림이 되므로 그것만 막는다.
       */
      const onDeal = body.onDeal === true || body.onDeal === 'true' || body.onDeal === 1 || body.onDeal === '1';
      if (targetPrice <= 0 && !onDeal) {
        return res.status(400).json({ error: '목표 가격을 넣거나 AI 추천 알림을 켜 주세요' });
      }
      if (targetPrice < 0) return res.status(400).json({ error: '목표 가격이 올바르지 않습니다' });

      /*
       * 새 모바일 알림은 현재 화면에 표시된 정확한 옵션 가격을 기준으로 목표가를 잡는다.
       * 목표가가 현재가와 같거나 높으면 check-alerts 의 `cur <= target_price` 조건을
       * 생성 직후 만족해 의미 없는 즉시 알림이 된다. 옵션 식별자를 보내는 새 경로만
       * 여기서 막고, vendorItemId 가 없는 기존 웹 알림 계약은 그대로 둔다.
       */
      if (vendorItemId && targetPrice > 0 && currentPrice > 0 && targetPrice >= currentPrice) {
        return res.status(400).json({ error: '목표 가격은 현재 표시 가격보다 낮게 입력해 주세요' });
      }

      const row = {
        email,
        title,
        target_price: targetPrice,
        current_price: currentPrice,
        link: String(body.link || '').slice(0, 2000),
        image: String(body.image || '').slice(0, 2000),
        mall: String(body.mall || '').slice(0, 100),
        // 다시 신청하면 조건 충족 시 또 받아볼 수 있어야 한다.
        sent: false
      };

      /*
       * 새 모바일 알림은 product + mall + vendorItemId 로 옵션을 고정한다.
       * vendorItemId 를 받은 요청에서 컬럼이 없다고 이 값을 버리고 저장하면,
       * check-alerts 가 같은 상품 페이지의 다른 옵션 가격으로 메일을 보낼 수 있다.
       * 따라서 "옵션을 보내온 요청"은 저장 능력이 없으면 503으로 fail-closed 한다.
       *
       * 기존 웹은 vendorItemId 를 보내지 않는다. 그 경로는 과거 마이그레이션
       * 호환성을 위해 기존처럼 product_id / on_deal 컬럼이 없는 DB까지 물러난다.
       */
      const payload = {
        ...row,
        product_id: productId,
        vendor_item_id: vendorItemId,
        on_deal: onDeal
      };
      let onDealSaved = onDeal;
      let error = null;

      for (let attempt = 0; attempt < 4; attempt++) {
        ({ error } = await supabase.from('alerts').upsert(payload, { onConflict: 'email,title' }));
        if (!error) break;

        if (missingColumn(error, 'vendor_item_id')) {
          if (vendorItemId) {
            return res.status(503).json({
              error: '이 옵션의 가격 알림을 안전하게 저장할 준비가 아직 끝나지 않았어요. 잠시 후 다시 시도해 주세요.',
              optionIdentityUnavailable: true
            });
          }
          console.warn('[alerts] vendor_item_id 컬럼 없음 — 기존 웹 알림으로 저장합니다.');
          delete payload.vendor_item_id;
          continue;
        }

        if (missingColumn(error, 'on_deal')) {
          console.warn('[alerts] on_deal 컬럼 없음 — supabase/2026-08-28-alert-on-deal.sql을 실행하세요.');
          onDealSaved = false;
          if (onDeal && targetPrice <= 0) {
            return res.status(503).json({
              error: 'AI 추천 알림은 아직 준비 중이에요. 목표 가격을 넣어 신청해 주세요.',
              onDealUnavailable: true
            });
          }
          delete payload.on_deal;
          continue;
        }

        if (missingColumn(error, 'product_id')) {
          if (vendorItemId) {
            return res.status(503).json({
              error: '이 옵션의 가격 알림을 안전하게 저장할 준비가 아직 끝나지 않았어요. 잠시 후 다시 시도해 주세요.',
              optionIdentityUnavailable: true
            });
          }
          console.warn('[alerts] product_id 컬럼 없음 — supabase/2026-08-hardening.sql을 실행하세요.');
          delete payload.product_id;
          continue;
        }

        break;
      }

      const msg = dbError(error, 'alerts');
      if (msg) throw new Error(msg);

      const dropped = onDeal && !onDealSaved;
      return res.json({
        success: true,
        msg: dropped ? '목표가 알림만 신청됐어요. AI 추천 알림은 아직 준비 중이에요.' : '알림 신청 완료!',
        onDeal: onDealSaved,
        optionBound: !!vendorItemId,
        vendorItemId: vendorItemId || ''
      });
    }

    if (req.method === 'DELETE') {
      const body = readBody(req);
      const email = readEmail(body.email);
      const title = String(body.title || '').trim();

      if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });
      if (!title) return res.status(400).json({ error: '상품명 없음' });
      if (!requireAuth(req, res, email)) return;

      const { error } = await supabase.from('alerts').delete().eq('email', email).eq('title', title);
      const msg = dbError(error, 'alerts');
      if (msg) throw new Error(msg);

      return res.json({ success: true });
    }

    res.status(405).json({ error: 'GET / POST / DELETE만 지원' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
