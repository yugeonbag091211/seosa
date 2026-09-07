'use strict';
/*
 * 전환(conversion) 정규화 — 순수 함수.
 *
 * ── 이 파일이 지키는 단 하나의 선 ──────────────────────────────────
 *
 *     클릭은 구매가 아니다.
 *
 * affiliate_click 은 funnel_events 로 가고, 여기서 만드는 행만 conversions
 * 로 간다. 이 파일에는 클릭에서 전환을 «추정» 하는 코드가 없고, 만들 자리도
 * 두지 않는다. 클릭 수 × 단가 = GMV 는 매출이 아니라 희망이다.
 *
 * ── 왜 '정상' 을 CONFIRMED 로 보지 않는가 ──────────────────────────
 *
 * ADPICK 의 '정상' 은 «주문이 정상적으로 접수됐다» 는 뜻이지 «정산이
 * 확정됐다» 가 아니다. 그 뒤에 '확인중' 을 거쳐 '확정' 또는 '취소' 로 간다.
 * '정상' 을 확정으로 세면 나중에 취소될 주문까지 매출로 잡히고, 되돌릴
 * 때쯤엔 이미 그 숫자로 의사결정이 끝나 있다.
 */

/* ==================================================================
 *  1) 내부 표준 상태
 * ================================================================== */

const STATUS = {
  ORDERED: 'ORDERED',      // 주문 접수 — 아직 확정 아님
  PENDING: 'PENDING',      // 파트너 검수 중
  CONFIRMED: 'CONFIRMED',  // 확정 — ★ 이것만 매출로 센다
  CANCELLED: 'CANCELLED',  // 취소
  UNKNOWN: 'UNKNOWN'       // 파트너가 모르는 값을 줬다 (버리지 않고 남긴다)
};

/**
 * ADPICK status → 내부 표준.
 *
 * 공식 계약에 명시된 네 값만 매핑한다. 그 밖의 값은 UNKNOWN 이고 원문은
 * partner_status 에 그대로 남는다 — 매핑이 틀렸을 때 되짚을 근거가
 * 사라지면 안 되기 때문이다.
 */
const ADPICK_STATUS = {
  '정상': STATUS.ORDERED,
  '확인중': STATUS.PENDING,
  '확정': STATUS.CONFIRMED,
  '취소': STATUS.CANCELLED
};

function canonicalStatus(partner, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (partner === 'adpick') return ADPICK_STATUS[s] || STATUS.UNKNOWN;
  /*
   * 쿠팡은 매핑하지 않는다.
   *
   * 2026-09-07 실측 probe: orders 리포트는 HTTP 200 / rCode 0 이지만 data 가
   * 0건이라 «어떤 필드로 상태를 표현하는지» 를 보지 못했고, cancel 리포트는
   * 404 였다. 의미를 모르는 값을 CONFIRMED 로 접는 것은 매출을 지어내는
   * 일이다. 확인될 때까지 UNKNOWN 으로 둔다.
   */
  return STATUS.UNKNOWN;
}

/** 매출로 세는 상태인가. 회계 규칙이 이 한 줄에 다 보이게 둔다. */
function countsAsRevenue(status) { return status === STATUS.CONFIRMED; }

/* ==================================================================
 *  2) attribution 토큰 — ADPICK p_data / 쿠팡 subId
 *
 *  ★ 개인정보를 담지 않는다.
 *    이메일·계정 id·원본 visitor_id·상품명을 넣지 않는다. 파트너 응답으로
 *    되돌아오는 값이라 파트너 쪽 로그에도 남고, 우리가 지울 수 없다.
 *
 *  ★ 무엇을 담는가 — 불투명 난수(opaque token) 또는 비개인 캠페인 코드.
 *      길이   최대 50자 (ADPICK p_data 공식 상한)
 *      수명   토큰 자체는 상태를 갖지 않는다. conversions.sub_id 에 남을 뿐
 *             다른 표와 조인하지 않는다 — 개인을 되짚는 경로를 만들지 않는다.
 *      용도   "이 전환이 어느 캠페인/화면에서 왔는가" 하나뿐이다.
 *
 *  ★ 법률 단정을 하지 않는다. "개인정보가 아니다"·"PIPA 완전 준수" 같은
 *    문장을 코드나 문서에 쓰지 않는다 — 우리가 판단할 자리가 아니다.
 * ================================================================== */

const SUBID_MAX = 50;
/** 허용 문자: 영숫자·하이픈·밑줄. 그 외는 통째로 거부한다(잘라 쓰지 않는다). */
const SUBID_RE = /^[A-Za-z0-9_-]{1,50}$/;
/** 캠페인 코드 화이트리스트. 화면 이름이지 개인이 아니다. */
const CAMPAIGNS = ['hotdeal', 'search', 'product', 'radar', 'home', 'compare', 'ai'];

/**
 * attribution 토큰을 만든다. 부르는 쪽이 개인 값을 넘겨도 통과시키지 않는다.
 *
 * @param {string} campaign CAMPAIGNS 안의 값
 * @param {string} nonce    불투명 난수 (선택). 없으면 캠페인만 남긴다.
 * @returns {string} 안전하지 않으면 빈 문자열
 */
function attributionToken(campaign, nonce) {
  const c = String(campaign || '').trim().toLowerCase();
  if (CAMPAIGNS.indexOf(c) === -1) return '';
  const n = String(nonce || '').trim();
  if (!n) return c;
  // 난수처럼 생기지 않은 값(이메일·계정 id 등)은 붙이지 않는다.
  if (!/^[A-Za-z0-9]{6,32}$/.test(n)) return c;
  const t = c + '-' + n;
  return t.length <= SUBID_MAX ? t : c;
}

/** 파트너가 돌려준 토큰을 저장 전에 검증한다. 이상하면 버린다. */
function safeSubId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (s.length > SUBID_MAX) return '';
  if (!SUBID_RE.test(s)) return '';
  // 이메일·전화번호 모양이면 우리 토큰이 아니다 — 저장하지 않는다.
  if (/@/.test(s) || /^\d{9,}$/.test(s)) return '';
  return s;
}

/* ==================================================================
 *  3) ADPICK 전환 행 → conversions 행
 *
 *  공식 계약 필드만 읽는다. 계약 밖 필드를 만들지 않는다.
 *    idx cp_code o_cd trlog_id p_cd regdate confirm_date p_nm qty
 *    sales commission commission_rate status trans_comment p_data
 *    link_id api_date
 * ================================================================== */

function int(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; }
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }

/** 'YYYY-MM-DD ...' 또는 'YYYYMMDD' → 'YYYY-MM-DD'. 못 읽으면 빈 문자열. */
function toDate(v) {
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return '';
}
function toTs(v) {
  const d = toDate(v);
  if (!d) return null;
  const s = String(v).trim();
  const t = Date.parse(/\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') + 'Z' : d + 'T00:00:00Z');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/*
 * ★ external_id 를 «합성하지 않는다».
 *
 * 공식 계약에는 idx · o_cd · trlog_id 세 식별자가 있는데, 어느 것이 전환
 * 하나를 유일하게 가리키며 «상태가 바뀌어도 유지되는지» 는 확인하지 못했다
 * (2026-09-07 probe 는 IP whitelist 403 이라 실데이터를 못 봤다).
 *
 * 그래서 둘을 이어 붙인 합성 키를 만들지 않는다. 합성 키는 한 번 쌓이면
 * 되돌릴 수 없고, 잘못 고르면 같은 전환이 두 행이 되거나 서로 다른 전환이
 * 한 행으로 덮인다.
 *
 * 대신 «단일 필드» 를 환경변수로 고르게 하고, 그 필드가 없는 행은 조용히
 * 넣지 않고 skip 으로 세어 보고한다. 기본값은 trlog_id 다 — 계약상 거래
 * 로그 식별자라 전환 1건에 대응할 가능성이 가장 높지만, **검증된 사실이
 * 아니라 기본값일 뿐이다.** whitelist 가 열려 실데이터를 본 뒤 확정한다.
 */
const ADPICK_ID_FIELDS = ['trlog_id', 'idx', 'o_cd'];
function adpickIdField() {
  const v = String(process.env.ADPICK_CONVERSION_ID_FIELD || '').trim();
  return ADPICK_ID_FIELDS.indexOf(v) > -1 ? v : 'trlog_id';
}

/**
 * @returns {{ok:true,row:object}|{ok:false,reason:string}}
 */
function fromAdpick(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-an-object' };

  const idField = adpickIdField();
  const externalId = str(raw[idField], 120);
  if (!externalId) return { ok: false, reason: 'no-' + idField };

  const partnerStatus = str(raw.status, 40);
  const status = canonicalStatus('adpick', partnerStatus);

  const orderDate = toDate(raw.regdate);
  if (!orderDate) return { ok: false, reason: 'no-regdate' };

  /*
   * sales = 실제 결제 금액, commission = 실제 발생 수수료.
   * 파트너가 준 값 그대로 쓴다. 비율(commission_rate)로 되계산하지 않는다 —
   * 되계산은 추정이고, 추정한 매출은 매출이 아니다.
   */
  const gmv = int(raw.sales);
  const commission = int(raw.commission);
  const qty = int(raw.qty) || 1;

  return {
    ok: true,
    row: {
      /* 기존 스키마 호환 (2026-09-07-funnel.sql) — 이름/뜻을 바꾸지 않는다 */
      source: 'adpick-report',
      external_id: externalId,
      order_date: orderDate,
      product_id: str(raw.p_cd, 120),
      mall: str(raw.cp_name || raw.cp_code, 40),
      gmv: gmv,
      commission: commission,
      quantity: qty,

      /* 2026-09-08 추가분 */
      partner: 'adpick',
      partner_status: partnerStatus,
      status: status,
      partner_order_id: str(raw.o_cd, 120),
      partner_conversion_id: str(raw.trlog_id || raw.idx, 120),
      partner_product_id: str(raw.p_cd, 120),
      sub_id: safeSubId(raw.p_data),
      ordered_at: toTs(raw.regdate),
      confirmed_at: status === STATUS.CONFIRMED ? toTs(raw.confirm_date) : null,
      cancelled_at: status === STATUS.CANCELLED ? (toTs(raw.confirm_date) || toTs(raw.regdate)) : null,
      updated_at: new Date().toISOString(),
      /*
       * 원본 일부만 남긴다. p_nm(상품명)·trans_comment 는 판매자 자유 문자열이라
       * 무엇이 섞여 올지 모른다 — 개인정보가 될 수 있는 필드는 애초에 담지 않는다.
       */
      raw_json: {
        idx: str(raw.idx, 60), o_cd: str(raw.o_cd, 60), trlog_id: str(raw.trlog_id, 60),
        cp_code: str(raw.cp_code, 40), link_id: str(raw.link_id, 60),
        commission_rate: str(raw.commission_rate, 20), api_date: str(raw.api_date, 40),
        status: partnerStatus
      }
    }
  };
}

/* ==================================================================
 *  4) 집계 — ordered / confirmed / cancelled 를 «절대» 섞지 않는다
 * ================================================================== */

function summarize(rows) {
  const out = {
    total: 0,
    byStatus: { ORDERED: 0, PENDING: 0, CONFIRMED: 0, CANCELLED: 0, UNKNOWN: 0 },
    orderedGmv: 0, confirmedGmv: 0, cancelledGmv: 0, commissionRevenue: 0
  };
  (rows || []).forEach(r => {
    if (!r) return;
    out.total++;
    const s = String(r.status || STATUS.UNKNOWN);
    if (out.byStatus[s] == null) out.byStatus[s] = 0;
    out.byStatus[s]++;
    const gmv = int(r.gmv);
    /*
     * ★ ORDERED/PENDING 은 «주문됐다» 이지 «확정» 이 아니다. orderedGmv 는
     *   참고값이고 매출이 아니다. confirmedGmv 와 절대 합치지 않는다.
     */
    if (s === STATUS.ORDERED || s === STATUS.PENDING) out.orderedGmv += gmv;
    if (s === STATUS.CONFIRMED) {
      out.confirmedGmv += gmv;
      out.commissionRevenue += int(r.commission);   // 확정 건의 실제 수수료만
    }
    if (s === STATUS.CANCELLED) out.cancelledGmv += gmv;
  });
  return out;
}

module.exports = {
  STATUS, ADPICK_STATUS, CAMPAIGNS, SUBID_MAX, ADPICK_ID_FIELDS,
  canonicalStatus, countsAsRevenue, attributionToken, safeSubId,
  fromAdpick, summarize, adpickIdField,
  _internal: { toDate, toTs, int, str }
};
