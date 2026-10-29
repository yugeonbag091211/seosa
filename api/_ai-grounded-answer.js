'use strict';

const SPEC_QUESTION_RE = /(?:무게|배터리|(?<!그)램|메모리|저장\s*공간|저장용량|용량|사양|스펙|노이즈\s*캔슬링|노캔|방수|흡입력|소음|소재|사이즈|화소|카메라|성능|칼로리|단백질|유통기한|원산지|전기세|몇\s*(?:kg|g|시간|그램|기가|mAh|Hz|인치))/i;
const SPEC_SHOPPING_RE = /(?:추천|비교|골라|찾아\s*(?:줘|주세요)|보여\s*(?:줘|주세요)|가격|판매가|현재가|최저가|할인|판매처|구매\s*링크)/i;
const HISTORY_QUESTION_RE = /(?:지금\s*사도|역대\s*최저|최저가\s*(?:기록|언제)|가격\s*(?:떨어|흐름|기록|이력|변동)|최근\s*한\s*달|할인\s*중|더\s*기다|싼\s*편|좋은\s*편|다음\s*(?:주|달)|가격이\s*내려|얼마였)/i;

const won = value => Math.round(Number(value) || 0).toLocaleString('ko-KR') + '원';
const dateLabel = value => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  return match ? match[1] : '';
};

function isProductSpecQuestion(question) {
  const q = String(question || '');
  if (!SPEC_QUESTION_RE.test(q) || SPEC_SHOPPING_RE.test(q)) return false;
  const asksOptionPrice = /(?:사이즈|옵션|모델)\s*(?:은|는|이|가|을|를)?\s*얼마(?:야|예요|임|인지|해요?)?/.test(q);
  const asksMeasuredFact = /(?:무게|배터리|흡입력|칼로리|단백질|전기세|용량|저장\s*공간|화소|유통기한|몇\s*(?:kg|g|시간|그램|기가|mAh|Hz|인치))/i.test(q);
  return !(asksOptionPrice && !asksMeasuredFact);
}

function isPriceHistoryQuestion(question) {
  return HISTORY_QUESTION_RE.test(String(question || ''));
}

function repairProductParticles(text, products) {
  let result = String(text || '');
  const pairs = [['을', '를'], ['이', '가'], ['은', '는'], ['과', '와']];
  const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const product of Array.isArray(products) ? products : []) {
    const title = String(product && product.title || '').trim();
    const last = title.slice(-1);
    const code = last.charCodeAt(0) - 0xAC00;
    if (!title || code < 0 || code >= 11172) continue;
    const hasBatchim = code % 28 !== 0;
    const pattern = new RegExp(`(${escapeRegExp(title)})(\\s*)(을|를|이|가|은|는|과|와)(?=[\\s,.!?。]|$)`, 'g');
    result = result.replace(pattern, (match, name, space, particle) => {
      const pair = pairs.find(values => values.includes(particle));
      const correct = pair && pair[hasBatchim ? 0 : 1];
      return correct ? `${name}${space}${correct}` : match;
    });
  }
  return result;
}

function groundedSpecificationAnswer(question, product) {
  const q = String(question || '');
  const title = String(product && product.title || '').trim();
  const units = title.match(/\d+(?:\.\d+)?\s?(?:GB|TB|mAh|kg|kcal|g|cm|mm|Hz|인치|AW|Pa|L|W)/gi) || [];
  const listedUnits = [...new Set(units.map(value => value.replace(/\s+/g, '')))].join(', ');
  const property = /무게|몇\s*(?:kg|그램)|\d\s*(?:kg|g)(?![A-Za-z])/i.test(q) ? '무게'
    : /배터리/.test(q) ? '배터리 사용 시간·용량'
        : /(?<!그)램|메모리/.test(q) ? '메모리'
        : /저장\s*공간|저장용량|용량|기가/.test(q) ? '용량'
          : /노이즈\s*캔슬링|노캔/.test(q) ? '노이즈 캔슬링 성능'
            : /방수/.test(q) ? '방수 등급'
              : /흡입력/.test(q) ? '흡입력'
                : /소음/.test(q) ? '소음 수치'
                  : /소재/.test(q) ? '소재'
                    : /사이즈/.test(q) ? '사이즈'
                      : /화소|카메라/.test(q) ? '카메라 사양'
                        : /성능|영상\s*편집/.test(q) ? '성능'
                          : /칼로리/.test(q) ? '칼로리'
                            : /단백질/.test(q) ? '단백질 함량'
                              : /유통기한/.test(q) ? '유통기한'
                                : /원산지/.test(q) ? '원산지'
                                  : /전기세/.test(q) ? '전력 소비 정보' : '요청하신 사양';

  if (!title) {
    return `요청하신 상품과 일치하는 데이터를 확인하지 못해 ${property} 자료를 확인할 수 없어요. 제조사 공식 사양이나 판매 페이지에서 확인해 주세요.`;
  }
  if (/램|메모리/.test(q) && /저장\s*공간|저장용량/.test(q)) {
    return listedUnits
      ? `검색된 상품명에는 ${listedUnits} 표기가 있어요. 상품명만으로 각 수치가 메모리와 저장 공간 중 어디에 해당하는지 구분할 수 없어, 세부 구성은 판매 페이지에서 확인해 주세요.`
      : `검색된 상품명에 메모리와 저장 공간 정보가 없어 확인할 수 없어요. 판매 페이지의 상세 사양을 확인해 주세요.`;
  }
  if (/노이즈\s*캔슬링|노캔/.test(q) && /노이즈\s*캔슬링|노캔|ANC/i.test(title)) {
    return `검색된 상품명에 노이즈 캔슬링 표기는 있어요. 다만 성능 수준을 비교할 측정 정보는 없어 실제 소음 저감 정도는 판단할 수 없어요.`;
  }
  const relevantUnits = property === '무게' ? units.filter(value => /(?:kg|g)$/i.test(value.trim()))
    : /배터리/.test(q) ? units.filter(value => /(?:mAh|시간)$/i.test(value.trim()))
      : /램|메모리|저장\s*공간|저장용량|용량|기가/.test(q) ? units.filter(value => /(?:GB|TB)$/i.test(value.trim()))
        : /방수/.test(q) ? units.filter(value => /(?:IPX?\s*\d|등급)/i.test(value.trim()))
          : /흡입력/.test(q) ? units.filter(value => /(?:AW|Pa|W)$/i.test(value.trim()))
            : /칼로리/.test(q) ? units.filter(value => /kcal$/i.test(value.trim()))
              : /단백질/.test(q) ? units.filter(value => /g$/i.test(value.trim()))
                : [];
  const relevantUnitText = [...new Set(relevantUnits.map(value => value.replace(/\s+/g, '')))].join(', ');
  if (relevantUnitText) {
    return `검색된 상품명에는 ${relevantUnitText} 표기가 있어요. 이 표기 외의 ${property} 정보는 확인되지 않아 단정하지 않을게요. 상세 구성은 판매 페이지에서 확인해 주세요.`;
  }
  return `검색된 상품 정보에 ${property} 자료가 없어 확인할 수 없어요. 제조사 공식 사양이나 판매 페이지에서 확인해 주세요.`;
}

function groundedPriceHistoryAnswer(question, product, deal) {
  const q = String(question || '');
  if (!product || !product.title) {
    const future = /다음\s*달/.test(q) ? '다음 달' : /다음\s*주/.test(q) ? '다음 주' : '';
    return `요청하신 상품·옵션의 가격 기록을 확인하지 못해 가격 흐름이나 최저가를 판단할 수 없어요. 비슷한 모델의 기록으로 대신 판단하지 않겠습니다.${future ? ` ${future} 가격도 예측할 수 없어요.` : ''}`;
  }

  const price = Math.round(Number(product.price || product.lprice) || 0);
  const original = Math.round(Number(product.oprice) || 0);
  const evidence = deal && deal.evidence || {};
  const count = Math.max(0, Math.round(Number(evidence.count) || 0));
  const low = Math.round(Number(evidence.low) || 0);
  const lowDate = dateLabel(evidence.lowDate);
  const historyQuestion = isPriceHistoryQuestion(q);

  if (/할인\s*중|할인/.test(q)) {
    if (price > 0 && original > price) {
      const discount = Math.round((original - price) / original * 100);
      return `검색 결과의 표시 판매가는 ${won(price)}, 표시 정가는 ${won(original)}예요. 상품 정보상 판매가가 표시 정가보다 ${discount}% 낮게 나와 있어요. 쿠폰·배송비·카드 혜택을 반영한 실제 결제 금액은 판매처 결제 화면에서 확인해 주세요.`;
    }
    const listedDiscount = /정가\s*대비\s*(\d+(?:\.\d+)?)\s*%\s*할인/.exec(String(product.note || product.priceNote || ''));
    if (price > 0 && listedDiscount) {
      return `검색 결과의 표시 판매가는 ${won(price)}이고, 상품 정보에는 정가 대비 ${listedDiscount[1]}% 할인으로 표시돼 있어요. 쿠폰·배송비·카드 혜택을 반영한 실제 결제 금액은 판매처 결제 화면에서 확인해 주세요.`;
    }
    return price > 0
      ? `검색 결과에 표시된 판매가는 ${won(price)}예요. 비교할 표시 정가가 확인되지 않아 할인 중인지는 판단할 수 없고, 실제 결제 금액은 쿠폰·배송비 등을 포함해 판매처에서 확인해 주세요.`
      : '확인된 판매가와 비교할 정가가 없어 할인 여부를 판단할 수 없어요. 판매처의 현재 상품 페이지를 확인해 주세요.';
  }

  const lead = price > 0 ? `검색 결과에 표시된 판매가는 ${won(price)}예요.` : '';
  if (count <= 0 || low <= 0) {
    return `${lead}${lead ? ' ' : ''}SEOSA에서 확인할 수 있는 가격 기록이 없어 과거 최저가나 가격 흐름을 판단할 수 없어요. 다음 주 가격도 예측할 수 없습니다.`;
  }
  if (count === 1 || evidence.lowConfirmed === false) {
    const observationDate = lowDate || dateLabel(evidence.lastDate);
    const lowCount = Math.max(0, Math.round(Number(evidence.lowCount) || 0));
    const dateFact = observationDate ? `${observationDate}에 ${won(low)}이 관측됐어요.` : '';
    const oneLow = lowCount === 1 && count > 1 ? ' 이 가격은 한 번만 관측돼 기록 최저가로 확정하지 않습니다.' : '';
    const future = /다음\s*달/.test(q) ? '다음 달' : /다음\s*주/.test(q) ? '다음 주' : '';
    const checkout = price > 0 ? ' 실제 결제 금액은 쿠폰과 배송비에 따라 달라질 수 있어요.' : '';
    const sourceText = count === 1
      ? `SEOSA 가격 기록은 1건뿐이에요. ${dateFact} 이 한 건만으로 가격 흐름이나 기록 최저가를 판단할 수 없어요.`
      : `SEOSA에서 확인한 가격 기록은 ${count}건이에요. ${dateFact}${oneLow} ${historyQuestion ? '이 기록만으로 가격 흐름이나 기록 최저가를 확정하기는 어려워요.' : ''}`;
    return `${lead}${lead ? ' ' : ''}${sourceText}${future ? ` ${future} 가격도 예측할 수 없어요.` : ''}${checkout}`;
  }

  const historyDays = Math.max(0, Math.round(Number(evidence.historyDays) || 0));
  const lowFact = `SEOSA 보유 관측 기록${historyDays ? ` ${historyDays}일 범위` : ''}에서 가장 낮은 가격은 ${lowDate ? `${lowDate}의 ` : ''}${won(low)}예요.`;
  const trendPct = Number(evidence.trendPct);
  const trendDays = Math.max(0, Math.round(Number(evidence.trendDays) || 0));
  let trend = '';
  if (Number.isFinite(trendPct) && trendDays > 0 && Math.abs(trendPct) >= 0.05) {
    const pct = Math.round(Math.abs(trendPct) * 10) / 10;
    trend = ` 최근 ${trendDays}일 관측 구간에서는 ${pct}% ${trendPct < 0 ? '내렸어요' : '올랐어요'}.`;
  }
  const future = /다음\s*달/.test(q) ? '다음 달' : /다음\s*주/.test(q) ? '다음 주' : '';
  const forecast = future || /더\s*떨어|기다/.test(q) ? ` ${future || '앞으로'} 가격이 더 내려갈지는 이 기록만으로 예측할 수 없어요.` : '';
  const checkout = price > 0 ? ' 실제 결제 금액은 쿠폰과 배송비에 따라 달라질 수 있어요.' : '';
  return `${lead}${lead ? ' ' : ''}${lowFact}${trend}${forecast}${checkout}`;
}

module.exports = {
  isProductSpecQuestion, isPriceHistoryQuestion,
  groundedSpecificationAnswer, groundedPriceHistoryAnswer, repairProductParticles
};
