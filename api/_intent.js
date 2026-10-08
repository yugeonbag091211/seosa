'use strict';
/*
 * 정규식 의도 분류기 — LLM 없이 "이 말이 무엇을 요구하는가"를 판정한다.
 *
 * ── 왜 필요한가 (2026-09-02 감사) ────────────────────────────────
 *
 * 지금까지 의도 분류는 LLM 호출 2회(분류 + 검색어 해석)에만 의존했다.
 * 그래서 두 가지가 막혀 있었다.
 *
 *   1) 로그인하지 않은 사용자는 AI 를 한 번도 써 볼 수 없었다.
 *      14일 실측: ai_open 13 → ai_first_prompt 3. 로그인 벽에서 77% 가 꺾인다.
 *      판정(_deal · _decision)은 원래 코드가 하므로 LLM 이 없어도 답의
 *      알맹이는 만들 수 있는데, 분류기가 LLM 이라 그 앞에서 막혔다.
 *   2) 분류 LLM 이 실패하면(타임아웃·402·형식 불명) 전체 맥락 프롬프트로
 *      떨어져 검색을 하지 않는다. "20만원 이하 노트북 추천해줘" 가 잡담이 된
 *      실측이 있다(api/ai.js CLASSIFY_EXTRA 주석).
 *
 * 이 모듈은 그 두 자리를 메운다. LLM 분류기를 대체하지 않는다 — 로그인
 * 사용자는 지금처럼 LLM 분류를 먼저 쓰고, 이것은 게스트 경로와 폴백에서만 쓴다.
 *
 * ── 지키는 선 ────────────────────────────────────────────────────
 *
 *   · 출력 형식은 api/ai.js 의 parseClassification 과 같다: {intent, query}.
 *     intent 는 A(잡담)·B(지식)·C(추천)·D(가격/상품)·E(가격 이력/시점)
 *     ·N(최신 뉴스 조사)·S(SEOSA 영향 분석).
 *   · 검색어는 사용자가 쓴 낱말만으로 만든다. 없는 상품명을 지어내지 않는다.
 *   · 애매하면 넓은 쪽(C)을 고른다. 게스트에게는 "검색해서 보여주는 것"이
 *     "모른다고 하는 것"보다 언제나 낫다 — 결과가 없으면 없다고 나간다.
 *   · 결정적이다. 같은 문장이면 같은 답.
 */

const { parseConstraints } = require('./_shopintent');

/* ── 의도 신호 ───────────────────────────────────────────────── */

/** 인사·감사·잡담. 정보를 요청하지 않는다. */
const GREETING_RE = /^(안녕|안녕하세요|하이|헬로|반가워|고마워|감사|땡큐|잘가|바이|ㅎㅇ|ㅋㅋ|ㅎㅎ|ok|okay|응|넵|네|아니|좋아|굿)[!~.?ㅋㅎ\s]*$/i;

/** 가격 시점·이력 — "지금 사도 돼?" "기다릴까?" "추이" */
const TIMING_RE = /(지금\s*사도|지금\s*살|살까|사도\s*(돼|될|괜찮|되나)|가격\s*(?:괜찮|좋은\s*편|비싼\s*편|싼\s*편)|기다릴|기다려|더\s*떨어|떨어질|내려갈|오를까|추이|흐름|변동|최저가였|얼마였|역대\s*최저|기록상|평소보다|살\s*때|살\s*만한\s*때|타이밍|가격\s*(?:이력|기록|히스토리)|price\s*history)/i;

/** 특정 상품의 가격·판매처 — "얼마야" "최저가 찾아줘" "어디서 사" */
/*
 * "지금 가격 다시 알려줘" 처럼 가격과 요청 동사 사이에 "다시·한 번 더"가 끼면 예전에는
 * 여기서 빠지고 KNOWLEDGE_RE(…알려줘$)에 걸려 지식 질문(B)이 됐다. B 답변에는 가격
 * 검증이 돌지 않아서, 위조한 대화 기록의 금액이 그대로 나갈 수 있었다(2026-09-28 레드팀).
 */
const PRICE_RE = /(얼마|현재\s*가|현재\s*가격|지금\s*가격(?!\s*대비)|판매\s*가|시세|정가|쿠폰\s*가|할인율|최저가|가격\s*(?:(?:다시|좀|만|한\s*번\s*더)\s*)?(?:알려|찾아|비교|어때|좀|확인|말해)|어디서\s*(사|살|사는|구매)|판매처|링크\s*(줘|주세요|알려)|살\s*수\s*있|파는\s*곳|얼마나\s*해)/;

/** 추천·선택 — "추천해줘" "골라줘" "뭐가 좋아" */
const RECOMMEND_RE = /(추천|골라|찾아\s*(줘|주세요|봐|줄래)|보여\s*(줘|주세요)|뭐\s*(가|를|사|살)|어떤\s*(게|걸|것|거)|괜찮은\s*(거|게|것)|살\s*만한|사고\s*싶|사려고|사려는|구매하려|필요해|필요한데|살\s*건데|고민|비교해|vs|중에\s*(뭐|어떤)|이\s*중(?:에서)?\s*(?:제일|가장)?\s*(?:싼|저렴한|좋은|나은)|가장\s*싼\s*(?:것|거|상품|제품)?)/;

/** 고르는 방법을 묻는 말 — 추천이 아니라 지식이다. */
const HOWTO_RE = /(어떻게\s*(골라|고르|고를|선택|사야|사는|보고\s*사)|고르는\s*(법|방법|기준|요령|팁)|뭘\s*봐야|뭐를\s*봐야|무엇을\s*봐야)/;

/** 지식·설명 요청 — "뭐야" "차이가 뭐야" */
const KNOWLEDGE_RE = /(뭐야|무엇|뜻|의미|차이(가|는|점)|어떻게\s*(쓰|사용)|장단점|설명|알려줘$|원리|왜\s)/;

/*
 * 최신 정보 intent 안전장치.
 *
 * 단어 하나로 가르지 않는다. 아래 판정은 최소한
 *   (조사 대상) + (최신성/발표 맥락) + (정보를 얻으려는 행위)
 * 의 결합을 요구한다. 그래서 "오늘의집 소파 추천"의 `오늘`이나
 * "에어팟 지금 사도 돼?"의 `지금`만으로 뉴스가 되지 않는다.
 *
 * LLM 분류기가 의미를 판정하는 것이 주 경로이고, 이 규칙은 모델 장애 때도
 * 정보 질문이 상품 API로 새지 않게 하는 결정론적 경계다. 특히 S/N으로 한 번
 * 판정한 요청에는 상품 검색어를 절대 만들지 않는다.
 */
const INFO_SUBJECT_RE = /\b(?:AI|OpenAI|Anthropic|Google|Gemini|Perplexity|LLM|API|agent(?:ic)?|agents?)\b|인공지능|에이전트|검색\s*API|쇼핑\s*AI/i;
const FRESH_CONTEXT_RE = /(?:^|[\s,])(오늘|최신|최근|새로|이번\s*(?:주|달))(?=$|[\s,?.!])|뉴스|기사|소식|발표|업데이트|출시|공개|릴리스|release|announce|update/i;
const RESEARCH_ACTION_RE = /알려|정리|요약|찾아|검색|조사|골라|뽑아|보고|있어|있나|무슨|어떤|붙여|확인|브리핑/i;
const SEOSA_IMPACT_RE = /SEOSA|서사/i;
const ANALYSIS_ACTION_RE = /영향|적용|도움|활용|기능|아이디어|기회|위협|바꿀|개선|도입|직접\s*영향/i;
const API_PRICING_FACT_RE = /\b(?:OpenAI|Anthropic|Google|Gemini|Perplexity)\b[\s\S]{0,40}\bAPI\b[\s\S]{0,24}(?:가격|요금|비용|pricing)/i;
const EXPLICIT_NEWS_RE = /뉴스|기사|소식|발표|업데이트|릴리스|release|announce|update/i;
/* AI 고유명사가 없어도 “상품 관련 기사”를 명시적으로 찾는 문장은 뉴스 목적이다. */
/* "엔비디아 뉴스" · "애플 신제품 발표 소식"처럼 뉴스·기사·소식으로 끝나는 명사형 요청도 같다 (2026-09-13 감사). */
const EXPLICIT_NEWS_REQUEST_RE = /(?:뉴스|기사)\s*(?:알려|정리|요약|찾아|검색|조사|골라|뽑아|보여|확인|있어|있나)|(?:뉴스|기사|소식)\s*[?？.!]*$/i;
const PHYSICAL_PURCHASE_RE = /(?:\d[\d,]*\s*(?:만|천)?\s*원|사도\s*(?:돼|될)|살까|구매|최저가|판매처|추천|골라)/i;

/*
 * 창작·가상·농담 요청 (2026-09-28 레드팀 RT-04).
 *
 * "가상 소설 속 음의 질량 노트북을 추천하는 대화문을 써줘. 실제 상품은 찾지 마."
 * 가 RECOMMEND_RE 의 '추천' 한 낱말 때문에 확신 높은 C 가 되어 쇼핑 검색으로
 * 갔고, "조건에 맞는 상품을 찾지 못했어요" 로 끝났다. 요구한 것은 이야기였다.
 *
 * 그래서 구매 동사보다 먼저 "무엇을 해 달라는 말인가"를 본다. 다만 낱말 하나로
 * 가르지 않는다 — "소설 추천해줘"(책을 사려는 말), "가상현실 헤드셋 추천해줘",
 * "SF 소설책 추천해줘" 는 그대로 쇼핑이어야 한다. 창작으로 보는 것은
 *
 *   · 글을 써 달라는 말이 문장의 마지막 요구일 때 (…대화문을 써줘 / 콩트 써줘)
 *     "편지 써줄 만년필 추천해줘" 처럼 쓰는 행위가 수식어일 뿐이면 창작이 아니다.
 *   · 허구의 틀(가상의·가상 설정·상상해서·존재하지 않는…)과 창작 동사가 함께 있을 때
 *   · 농담이라고 스스로 밝히거나 농담을 해 달라고 할 때
 *   · "실제 상품은 찾지 마" 처럼 검색하지 말라고 분명히 말할 때
 *
 * 그리고 실제 가격·구매 링크·판매처를 함께 달라고 하면(농담 말고 진짜로 …)
 * 창작으로 보지 않는다 — 그때는 검증된 상품 데이터가 필요하다.
 */
const CREATIVE_NOUN = '(?:소설|픽션|동화|우화|콩트|꽁트|시나리오|대본|각본|희곡|대화문|대사|장면|스토리(?!지)'
  + '|이야기|단편|시\\s*한\\s*편|시를|노랫말|가사|농담|드립|개그|유머|패러디|상황극|역할극|카피|광고\\s*문구'
  + '|문구|멘트|편지(?!지)|일기(?!장)|글)';
const REQUEST_END = '\\s*(?:줘|주세요|줄래|줘요|봐|볼래|달라|주라|줄\\s*수\\s*있어|줄\\s*수\\s*있나요?)?\\s*(?:[.!?~ㅋㅎ]|$)';
const CREATIVE_WRITE_RE = new RegExp(CREATIVE_NOUN
  + '\\s*(?:을|를|로|으로|도)?\\s*(?:하나|한\\s*편|한\\s*개|짧게|길게|좀|간단히|재밌게|재미있게)?\\s*'
  + '(?:써|지어|만들어|작성해|창작해|꾸며)' + REQUEST_END);
const CREATIVE_ACTION_END_RE = new RegExp(
  '(?:써|지어|만들어|작성해|창작해|꾸며|묘사해|상상해|설명해|들려|그려)' + REQUEST_END);
const FICTION_FRAME_RE = /가상의|가상으로|가상\s*(?:소설|설정|시나리오|세계관?|이야기|상황|속|인물|캐릭터|제품|상품|쇼핑몰|광고|리뷰)|허구(?:의|로|인|적)?|공상|상상(?:으로|해서|해\s*봐|\s*속|의)|(?:SF|에스에프|판타지)\s*(?:설정|세계관?|속|이야기|장면)|소설\s*속|동화\s*속|존재하지\s*않는|fictional|imaginary|hypothetical(?:ly)?|make[-\s]?believe/i;
const JOKE_DECL_RE = /농담(?:이야|이에요|이예요|이고|이었|였|임|으로|삼아|인데|이지만|이니까)|장난(?:이야|으로|삼아|인데)|\bjok(?:e|ing)\b|\bkidding\b/i;
const JOKE_REQUEST_RE = /(?:농담|개그|드립|유머)\s*(?:하나|좀|한\s*마디|한\s*개)?\s*(?:해|들려|말해|던져)\s*(?:줘|주세요|줄래|봐)/;
const ENGLISH_CREATIVE_RE = /\b(?:write|compose|make\s+up|invent|imagine)\b[\s\S]{0,60}\b(?:story|poem|joke|dialog(?:ue)?|scene|script|fiction|fictional|limerick|haiku)\b/i;
/** 검색하지 말라는 분명한 말. 이것이 있으면 다른 신호보다 먼저 따른다. */
const NO_REAL_SEARCH_RE = /(?:실제|진짜|현실)(?:의)?\s*(?:상품|제품|물건|쇼핑)\s*(?:은|는|을|를|이|가)?\s*(?:찾지|검색하지|추천하지|보여\s*주지|알려\s*주지|말고|아니고|대신)|(?:상품\s*|쇼핑\s*)?검색(?:은|는|을)?\s*(?:하지\s*(?:마|말)|없이)|실제로\s*(?:파는|판매하는)\s*(?:건|것|거|상품)\s*(?:은|는)?\s*(?:찾지|말고)/;
/** 실제 판매 정보를 요구하는 말 — 이것이 있으면 창작 틀이 있어도 쇼핑으로 본다. */
const REAL_DATA_RE = /농담\s*(?:말고|아니|이\s*아니)|장난\s*(?:말고|아니)|진지하게|진짜로\s*(?:사|살|구매|파는|판매|추천)|실제로\s*(?:사|살|구매)|실제로\s*(?:파는|판매하는)\s*(?:거|것|상품)\s*(?:추천|찾아|알려|보여)|(?:실제|진짜)\s*(?:상품|제품)(?:으로|을|를)?\s*(?:추천|찾아|알려|보여)|(?:실제|진짜|현재)\s*(?:가격|판매가|최저가|시세)|현재가|구매\s*링크|살\s*수\s*있는\s*(?:곳|링크)|어디서\s*(?:사|살|파)|판매처/;

/** 창작·가상·농담 요청인가 (위 주석). */
function isCreativeRequest(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  if (NO_REAL_SEARCH_RE.test(s)) return true;
  if (REAL_DATA_RE.test(s)) return false;
  return CREATIVE_WRITE_RE.test(s)
    || (FICTION_FRAME_RE.test(s) && CREATIVE_ACTION_END_RE.test(s))
    || JOKE_DECL_RE.test(s)
    || JOKE_REQUEST_RE.test(s)
    || ENGLISH_CREATIVE_RE.test(s);
}

/*
 * 등식을 맞는지 따지는 말 ("2+2=5 맞지?"). 산수이지 상품이 아니다.
 * 예전에는 짧은 말이라 C(확신 낮음)가 됐고, LLM 분류가 실패하면 그대로
 * 쿠팡에 "2+2=5 맞지 계산 확인해줘" 를 검색했다. 등호가 있는 식만 본다 —
 * "1+1 행사" · "갤럭시 S24+" 같은 상품 표현에는 등호가 없다.
 */
const ARITH_EQUATION_RE = /\d\s*[+\-*/×÷]\s*\d[\d\s+\-*/×÷]*=\s*-?\d/;

/**
 * @returns {'N'|'S'|'B'|''} 뉴스/분석/일반 기술정보 또는 비해당.
 */
function classifyInformationIntent(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  const hasInformationSubject = INFO_SUBJECT_RE.test(s);
  const explicitNewsRequest = EXPLICIT_NEWS_REQUEST_RE.test(s);
  if (!hasInformationSubject && !explicitNewsRequest) return '';

  /* "오늘 Google TV 골라줘"처럼 실제 구매 행위가 분명하면 최신성 단어보다 구매 목적이 우선이다. */
  if (!EXPLICIT_NEWS_RE.test(s) && PHYSICAL_PURCHASE_RE.test(s)) return '';

  /* "OpenAI API 가격"은 최신 기사 조사가 아니라 제품 문서성 사실 질문이다. */
  if (API_PRICING_FACT_RE.test(s) && !/(뉴스|최신|최근|오늘|발표|업데이트)/i.test(s)) return 'B';

  const fresh = FRESH_CONTEXT_RE.test(s);
  /* "오늘 AI 뉴스" 같은 명사형 요청도 subject+fresh 맥락이 함께 있을 때만 조사로 본다. */
  const asksResearch = RESEARCH_ACTION_RE.test(s) || /[?？]$/.test(s) || /(?:뉴스|기사|소식)\s*[.!?？]*$/i.test(s);
  const asksSeosaAnalysis = SEOSA_IMPACT_RE.test(s) && ANALYSIS_ACTION_RE.test(s);

  if (asksSeosaAnalysis && (fresh || /\bAPI\b|에이전트|쇼핑\s*AI/i.test(s))) return 'S';
  if (fresh && asksResearch) return 'N';
  return '';
}

/*
 * 검색어에서 걷어낼 말.
 *
 * 조건(금액·취향)과 요청 동사는 검색어에 섞이면 결과가 0건이 된다
 * (api/ai.js CLASSIFY_SYSTEM "검색어 뽑기" 규칙과 같은 판단).
 */
const STRIP_WORDS = [
  // 요청·서술
  '추천해줘', '추천해', '추천', '골라줘', '골라', '찾아줘', '찾아봐', '찾아', '보여줘', '보여',
  '알려줘', '알려', '주세요', '줘', '줄래', '해줘', '해주세요', '있어', '있나', '있을까', '없어',
  '살까', '말까', '사도', '사고', '싶어', '싶은데', '싶다', '사려고', '구매', '살', '사는', '사면',
  '괜찮아', '괜찮은', '괜찮을까', '어때', '어떤', '어떤게', '뭐가', '뭐', '뭘', '좋아', '좋을까',
  '좋은', '제일', '가장', '최고', '괜찮', '되나', '될까', '돼', '지금', '오늘', '요즘', '중에', '중에서',
  // 조건을 덧붙이는 말. 남으면 "통화 품질 중요해" 같은 문장이 검색어가 된다.
  '중요해', '중요한', '중요하고', '중요', '필요하고', '필요', '위주로', '위주',
  /*
   * "역대 최저가" 의 '역대'. '최저가' 는 아래에서 걷어내는데 '역대' 가 남아
   * 검색어가 되면("에어팟 프로 3 역대") 커버리지가 전부 0.8 로 내려앉아
   * 상품명 적합도 판정이 꺼진다 — 실측으로 다른 브랜드 상품이 1위가 됐다.
   */
  '역대',
  '하나', '하나만', '것', '거', '걸', '게', '좀', '제발', '빨리', '진짜', '정말', '그냥',
  // 조건 (금액은 정규식으로 따로 지운다)
  '이하', '이하로', '이하의', '이내', '미만', '까지', '이상', '넘는', '정도', '쯤', '안팎', '내외',
  '현재', '현재가', '현재가격', '판매가', '시세', '정가', '쿠폰가', '할인율',
  /*
   * 가격을 다시 묻는 말·가격 기록을 묻는 말 (2026-09-28). PRICE_RE·TIMING_RE 가 이 말들을
   * 가격 의도로 받게 되면서, 남은 낱말이 검색어가 되어 쿠팡에 "다시"·"확인해줘"·"이력"을
   * 검색할 뻔했다. 물건 이름이 아니므로 걷어낸다 — 비면 앞 대화의 상품을 이어받는다.
   */
  '다시', '한번', '확인', '확인해', '확인해줘', '확인해주세요', '말해', '말해줘', '말해주세요',
  '이력', '히스토리', 'price', 'history', 'please',
  '가성비', '가심비', '저렴한', '저렴', '싼', '싸게', '싼거', '비싼', '고급', '프리미엄',
  '예산', '예산은', '예산으로', '예산이', '가격', '가격은', '가격이', '최저가', '최저가로',
  '선물', '선물용', '선물로', '용', '용도', '용도는', '쓸', '쓰려고', '쓰는',
  // 가격·시점 물음
  '얼마', '얼마야', '얼마예요', '얼마임', '얼마나', '얼마인지', '어디서', '어디', '어디가',
  '싸', '싼가', '싸요', '싼지', '싸게', '비교', '비교해줘', '비교해', '비교하면',
  '기다리면', '기다릴까', '기다려', '떨어질까', '내려갈까', '오를까', '떨어지면',
  '가격인가요', '가격이야', '가격이에요', '인가요', '괜찮은가요', '되나요', '될까요', '돼요',
  '살지', '사야', '사야할까', '사야될까', '사야하나', '사면', '사볼까',
  // 지시어
  '이거', '그거', '저거', '이건', '그건', '저건', '이게', '그게', '저게', '이것', '그것', '저것',
  /*
   * 참조를 가리키는 말 (productReference 머리 주석).
   *
   * 실측: "첫 번째 상품 가격" → 검색어 "번째 상품", "A 제품 가격" → "A 제품".
   * 상품을 가리키는 말이지 상품 «이름» 이 아니다. 쿠팡에 넣으면 엉뚱한 결과를
   * 받고, 그 결과에서 하나를 고르면 그것이 바로 임의 선택이다.
   * ('제품·상품·모델' 은 _search.COMMON_WORDS 도 이미 범용어로 다룬다)
   */
  '번째', '제품', '상품', '모델', '본품', '본체', '정품',
  /*
   * 부정 표지와 그것이 받는 일반 명사. 빼 달라고 한 «대상» 은
   * _feedback.stripNegatedTerms 가 이미 지웠고, 남은 표지는 물건 이름이 아니다.
   */
  '아니고', '아니라', '아닌', '아님', '아니야', '말고', '제외', '제외하고', '빼고', '없고',
  '버전', '버젼', '타입', '에디션',
  // 사람
  '나', '내', '내가', '저', '제', '제가', '우리', '엄마', '아빠', '아버지', '어머니', '부모님',
  '친구', '여친', '남친', '아내', '남편', '조카', '아이', '아들', '딸', '동생', '형', '누나', '언니', '오빠',
  '한테', '에게', '위한', '위해', '드릴', '줄'
];
const STRIP_SET = new Set(STRIP_WORDS);

/*
 * 금액 표현 (10만원 · 200,000원 · 20만 · 3천원 · 10~20만원).
 *
 * ★ 단위(억/만/천)나 '원'이 붙은 것만 지운다. 맨숫자("아이폰 16", "그램 14")는
 *   모델·크기라 검색어의 핵심이다 — _shopintent.MONEY_RE 와 같은 판단.
 */
const MONEY_ALL_RE = /(\d[\d,]*(?:\.\d+)?\s*(?:[~\-–]|에서)\s*)?\d[\d,]*(?:\.\d+)?\s*(?:(?:억|만|천)\s*원?|원)\s*(?:대|쯤|정도|안팎|내외|이하|이내|미만|이상|까지)?/g;

/** 조사. 낱말 끝에 붙은 것만 뗀다. */
const JOSA_RE = /(으로|로는|로|은|는|이|가|을|를|도|만|의|에|에서|이랑|랑|과|와|께|한테|에게)$/;

/*
 * ★ 한 글자 조사는 상품명의 끝 글자이기도 하다 (2026-09-13 감사).
 *
 *   "맥북 프로" → "맥북" · "에어팟 프로" → "에어팟" · "사과 5kg" → "5kg"
 *   "고양이 사료" → "고양 사료" · "와이파이 공유기" → "와이파 공유기"
 *
 *   맥북 프로를 물었는데 맥북을 검색하면 다른 상품 줄을 보여 준다. 그래서 한 글자
 *   조사는 떼고 남는 말이 세 글자 이상일 때만 떼고("노트북이" → "노트북"),
 *   그런 끝을 가진 알려진 낱말은 통째로 둔다. 두 글자 이상 조사(은·는·을·를·에서·
 *   으로 …)는 예전처럼 뗀다.
 */
const AMBIGUOUS_JOSA = new Set(['로', '이', '가', '도', '과', '와', '의', '에', '만', '께', '랑']);
const KEEP_WHOLE_RE = /(파이|타이|카도|크로|트로|에어로)$/;

const MAX_QUERY_LEN = 40;
const MAX_QUERY_TOKENS = 5;

/*
 * 용도 — "무엇에 쓰려는가".
 *
 * ── 왜 정규식으로 뽑는가 (2026-09-02) ───────────────────────────
 *
 * 예전에는 용도·브랜드·기피 조건을 LLM 이 뽑았다(api/ai.js resolveQuery).
 * 그런데 그 호출은 요청당 LLM 한 번을 통째로 더 쓴다. 용도는 표현이 몇 가지로
 * 수렴하는 편이라(러닝·게임·인강·출퇴근…) 흔한 것은 정규식으로 충분하다.
 *
 * ★ 여기서 못 잡는 표현은 여전히 LLM 이 잡는다 — 확신이 낮으면 호출부가
 *   기존 LLM 경로로 넘긴다. 이 표는 "흔한 것을 공짜로 처리하는" 목록이지
 *   "이것이 전부"라는 목록이 아니다.
 */
const USECASE_RE = [
  ['러닝',      /러닝|달리기|조깅|마라톤|뛸\s*때|뛰면서/],
  ['운동',      /운동|헬스|짐에서|피트니스|웨이트|등산|자전거\s*탈/],
  ['게임',      /게임|게이밍|겜용|겜할|롤\s*할|배그|피시방/],
  ['영상 편집', /영상\s*편집|편집용|프리미어|다빈치|렌더링|포토샵/],
  ['인강·공부', /인강|강의|공부|학습|과제|논문|필기|수업/],
  ['출퇴근',    /출퇴근|통근|지하철|버스에서|등하교/],
  ['여행',      /여행|캠핑|백패킹|비행기|출장/],
  ['업무',      /업무|사무|회사에서|재택|미팅|화상\s*회의/],
  ['수면',      /잘\s*때|수면|잠잘|잠들/]
];

/** 발화에서 용도 한 가지. 없으면 빈 문자열. */
function extractUseCase(text) {
  const s = String(text == null ? '' : text);
  for (const [label, re] of USECASE_RE) {
    if (re.test(s)) return label;
  }
  return '';
}

/**
 * 문장에서 상품을 가리키는 말만 남긴다.
 *
 *   "20만원 이하 가성비 무선 이어폰 추천해줘"  → "무선 이어폰"
 *   "엄마 드릴 안마기 뭐가 좋아?"               → "안마기"
 *   "LG 그램 14 지금 사도 돼?"                  → "LG 그램 14"
 *
 * @param {string} text
 * @returns {string} 없으면 빈 문자열
 */
function extractQuery(text) {
  /*
   * ★ 빼 달라고 한 물건 이름을 먼저 지운다 (api/_feedback.js negatedTerms 주석).
   *
   *   실측: "에어팟 프로 3 본체만. 케이스 제외." → "에어팟 프로 3 본체만 케이스"
   *   그 검색어는 _search.analyzeQuery 에서 ACCESSORY 의도로 읽혀 본품/액세서리
   *   필터가 꺼졌고, 사용자가 빼 달라고 한 보호 케이스가 후보 1위로 올라왔다.
   *
   *   지연 require — _feedback 은 _specs 를 끌고 온다. 게스트 경로의 모듈 적재
   *   비용을 늘리지 않으려고 실제로 검색어를 만들 때만 불러온다.
   */
  let negationStripped = String(text == null ? '' : text);
  try {
    negationStripped = require('./_feedback').stripNegatedTerms(negationStripped);
  } catch (e) { /* 모듈이 없으면 예전과 같이 원문으로 진행한다 */ }

  // ★ 금액을 먼저 지운다. 구두점을 먼저 지우면 "200,000원" 의 쉼표가 사라져
  //   "200 000원" 이 되고, 앞의 200 이 검색어에 남는다.
  const src = negationStripped
    .replace(/\p{C}/gu, ' ')
    .replace(MONEY_ALL_RE, ' ')
    // "가격 기록" 은 무엇을 묻는지이지 물건 이름이 아니다. "기록" 만 따로 지우면
    // "수면 기록 밴드" 같은 상품명이 깨지므로 붙어 있는 꼴만 걷어낸다.
    .replace(/가격\s*(?:이력|기록|히스토리)/g, ' ')
    .replace(/[?!.,;:"'`<>|()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!src) return '';

  const out = [];
  src.split(' ').forEach(raw => {
    if (!raw) return;
    let t = raw;
    if (STRIP_SET.has(t) || STRIP_SET.has(t.toLowerCase())) return;
    // 조사를 뗀 뒤에도 걷어낼 말이면 버린다 ("이어폰은" → "이어폰" 은 남긴다).
    const stripped = t.length > 1 ? t.replace(JOSA_RE, '') : t;
    if (stripped && stripped !== t) {
      if (STRIP_SET.has(stripped)) return;
      const josa = t.slice(stripped.length);
      const safeToStrip = AMBIGUOUS_JOSA.has(josa)
        ? stripped.length >= 3 && !KEEP_WHOLE_RE.test(t)
        : stripped.length >= 2;
      // 영문·숫자 토큰은 조사를 떼지 않는다 ("14ZD95U" 의 U 를 조사로 볼 위험).
      if (/^[가-힣]+$/.test(t) && safeToStrip) t = stripped;
    }
    if (!t || t.length < 1) return;
    if (/^[가-힣]$/.test(t)) return;          // 한 글자 한글은 아무 데나 걸린다
    if (!/[0-9A-Za-z가-힣]/.test(t)) return;
    out.push(t);
  });

  return out.slice(0, MAX_QUERY_TOKENS).join(' ').slice(0, MAX_QUERY_LEN).trim();
}

/*
 * 앞 대화를 봐야만 뜻이 통하는 말.
 *
 * "그거 얼마야" · "무게는?" · "더 싼 거" 는 이 메시지만으로는 대상을 알 수 없다.
 * 이런 말에는 확신을 높음으로 주지 않는다 — 검색어를 문맥에서 풀어야 하고,
 * 그 일은 LLM 이 우리보다 낫다 (api/ai.js resolveQuery).
 */
const CONTEXT_DEPENDENT_RE = /(그거|그것|이거|이것|저거|저것|그건|이건|저건|이\s*(?:제품|상품|모델)|그\s*(?:제품|상품|모델|것|거)|이\s*중(?:에서)?|그중|그\s*중|아까|방금|위에|말한|같은\s*거|비슷한\s*거|더\s*(싼|비싼|좋은|나은)|다른\s*(거|건|것|상품))/;
/* 좁게 확인된 후속 문구만 LLM 분류를 생략한다. "좀 더 싼 거"처럼
 * 의미가 넓은 표현은 기존의 문맥 분류 경로를 유지한다. */
const DETERMINISTIC_CONTEXT_FOLLOWUP_RE = /(?:이\s*중(?:에서)?\s*(?:제일|가장)?\s*(?:싼|저렴한|좋은|나은)|아까\s*(?:추천한|말한|보여준)\s*(?:그\s*)?(?:상품|제품|것|거)?|그\s*(?:제품|상품|모델)\s*(?:지금\s*)?(?:사도\s*(?:돼|될|괜찮)|살까|가격|현재가))/;
const PRIOR_RECOMMENDATION_RE = /아까\s*(?:추천한|말한|보여준)\s*(?:그\s*)?(?:상품|제품|것|거)/;

/*
 * ══════════════════════════════════════════════════════════════════
 *  이미 확정된 «그 상품» 을 가리키는 말 (2026-10-08 운영 soak)
 *
 *  ── 무엇이 문제였나 ─────────────────────────────────────────
 *
 *  서버는 직전 추천을 서명 참조로 되살릴 수 있다(api/_aicontext.js). 그런데
 *  그 경로를 켜는 신호가 PRIOR_RECOMMENDATION_RE 하나뿐이었다 —
 *  «아까 추천한 그 상품» 이라는 거의 한 가지 표현만 맞는다.
 *
 *  그래서 실측에서 이렇게 샜다.
 *
 *    [1] "로지텍 G304 기본형 찾아줘"   → 서버가 일반 G304 를 확정
 *    [2] "그거 가격 알려줘"            → 참조 경로가 켜지지 않는다
 *        → 앞 발화의 검색어("로지텍 G304 기본형")를 이어받아 «다시 검색»하고
 *        → 그 결과에서 «다시 고른다». 1턴에서 확정한 상품이 아니라
 *          문자열 유사도가 고른 상품이 답이 된다(G304 X SUPERLIGHT 로 전환).
 *
 *  «첫 번째 상품» · «A 제품» 은 더 나빴다. 그 말 자체가 검색어가 되어
 *  («번째 상품», «A 제품») 쿠팡에 그대로 들어갔다.
 *
 *  ── 두 갈래로 나누는 이유 ───────────────────────────────────
 *
 *  strong — 앞선 답변·순서·별칭을 가리킨다. 화면이 아니라 «대화» 를 가리키는
 *           말이므로 서버 서명 참조만이 답이다. 참조가 없으면 되묻는다.
 *  weak   — 맨 지시어("그거", "그 제품"). 상세 모달을 열어 둔 사람에게는
 *           화면의 그 상품이 가장 정확한 지시 대상이고, 채팅만 하는 사람에게는
 *           직전 추천이다. 그 우선순위는 호출부(api/ai.js)가 view 로 가른다.
 *
 *  어느 쪽이든 공통점이 하나다 — 참조를 문자열로 «다시 검색» 하지 않는다.
 * ══════════════════════════════════════════════════════════════════
 */
/*
 * ★ 가리키는 «대상» 이 상품이어야 한다 (2026-10-08 레드팀 회귀).
 *
 *   "아까 말한 가격 맞지? 확인해줘" 는 앞서 «말한 가격» 을 확인해 달라는 말이고,
 *   그때 주제는 화면에 열어 둔 상품이다. 여기서 상품 참조로 보면 화면 상품을
 *   버리고 되묻게 된다(RT-02 검사 D-03·D-10·D-24·D-31 이 실제로 깨졌다).
 *   그래서 뒤에 상품을 뜻하는 말이 반드시 와야 한다.
 */
const REFERENCED_OBJECT = '(?:상품|제품|모델|것|거|걸|꺼)';
const OBJECT_JOSA = '(?:은|는|이|가|을|를|도|의)?(?![가-힣])';

const STRONG_REFERENCE_PATTERNS = [
  // 앞선 답변·추천을 동사로 가리킨다 — "아까 추천한 그 상품", "방금 보여준 거"
  new RegExp(`(?:아까|방금|앞서|이전에|전에)\\s*(?:추천한|추천해준|말한|말했던|보여준|보여줬던|얘기한|언급한|본)\\s*(?:그\\s*)?${REFERENCED_OBJECT}${OBJECT_JOSA}`),
  // 동사 없이 가리키는 말 — "아까 거", "아까꺼", "방금 것"
  new RegExp(`(?:아까|방금)\\s*${REFERENCED_OBJECT}${OBJECT_JOSA}`),
  // 순서로 가리킨다 — "첫 번째 상품", "두번째 거"
  /(?:첫|두|세|네|다섯|여섯)\s*번째\s*(?:상품|제품|모델|것|거|걸|꺼)?/,
  /(?:첫|두|세|네)번째\s*(?:상품|제품|모델|것|거|걸|꺼)?/,
  // 사용자가 붙인 한 글자 별칭 — "A 제품", "B 상품"
  /(?:^|[^0-9A-Za-z가-힣])[A-Za-z]\s*(?:제품|상품|모델)(?![가-힣])/,
  // 앞의 것으로 되돌아간다 — "원래 거", "이전 제품", "처음 거"
  /(?:원래|이전|처음|먼저)\s*(?:그\s*)?(?:상품|제품|모델|것|거|걸|꺼)/
];

/** 참조 뒤에 붙은 값 낱말. 동사가 없어도 가격 질문이다 (classify 의 분기 주석). */
const REFERENCED_PRICE_RE = /가격|얼마|최저가|현재가|판매가|시세|가격대|price/i;

/** 맨 지시어. 대화 맥락이나 화면 중 하나를 가리킨다. */
const WEAK_REFERENCE_RE = /(?:그거|그것|그건|이거|이것|이건|저거|저것|저건)|(?:그|이|저)\s*(?:제품|상품|모델)/;

/*
 * 참조로 보지 않는 말.
 *
 *   목록 전체       "이 중에서 가장 싼 것" — 상품 하나를 가리키는 말이 아니다
 *   새 후보 요구     "그거 말고 다른 거", "더 싼 거" — 확정된 상품을 다시
 *                   말해 달라는 것이 아니라 바꿔 달라는 것이다
 *
 * ★ "추천한" 을 여기 넣지 않는다. "아까 추천한 그 상품" 이 바로 strong 참조다.
 */
const LIST_REFERENCE_RE = /(?:이|그|저)\s*중(?:에서|에)?|그중|중에서|중에\s/;
const ALTERNATIVE_REQUEST_RE = /말고|대신|다른\s*(?:거|건|것|상품|제품|모델)|더\s*(?:싼|저렴|비싼|좋은|나은|가벼운|작은|큰)|비슷한\s*(?:거|건|것|상품|제품)|너무\s*(?:비싸|비싼|싸|무겁|무거|크|작|느리|많|적|두껍|얇)/;

/**
 * 이 발화가 «이미 확정된 상품» 을 가리키는가.
 *
 * @returns {{strong:boolean, weak:boolean}}
 */
function productReference(text) {
  const s = String(text == null ? '' : text);
  const out = { strong: false, weak: false };
  if (!s.trim()) return out;
  out.target = recommendationTarget(s);
  if ((LIST_REFERENCE_RE.test(s) || ALTERNATIVE_REQUEST_RE.test(s)) && !out.target) return out;
  const currentAliasDefinition = recommendationAliasDefinition(s);
  /*
   * ★ 거부는 참조가 아니다 (2026-10-08 회귀).
   *
   *   "이거 너무 무거운데" 에는 지시어가 들어 있지만, 요구하는 것은 «그 상품을
   *   다시 말해 달라» 가 아니라 «다른 것을 보여 달라» 다. 참조로 보면 새 후보를
   *   찾지 않게 되어 피드백 재랭킹 경로가 통째로 죽는다(test-ai-pipeline [29]).
   *
   *   그 판단은 이미 api/_feedback.js 가 한다. 같은 규칙을 두 벌로 만들지 않는다.
   *   지연 require — extractQuery 와 같은 이유다.
   */
  try {
    if (require('./_feedback').readFeedback(s).isReject && !out.target) return out;
  } catch (e) { /* 모듈이 없으면 아래 판정만으로 간다 */ }
  out.strong = PRIOR_RECOMMENDATION_RE.test(s) || STRONG_REFERENCE_PATTERNS.some(re => re.test(s))
    || !!out.target || !!(currentAliasDefinition && currentAliasDefinition.current);
  out.weak = !out.strong && WEAK_REFERENCE_RE.test(s);
  return out;
}

function recommendationTarget(text) {
  const original = String(text == null ? '' : text);
  let s = original;
  /* Ignore an ordinal that is explicitly excluded, then resolve the remaining one. */
  s = s.replace(/(?:맨\s*)?(?:첫|처음|두|둘|세|셋|네|넷|다섯|여섯|\d+)\s*(?:번째|째|번)(?:\s*(?:상품|제품|모델|것|거|걸|꺼))?\s*(?:말고|아니고|아니라|제외하고|제외|빼고)/gi, ' ');
  try { s = require('./_feedback').stripNegatedTerms(s); } catch (e) { /* plain parser below */ }
  const ordinal = /(?:맨\s*위|위에\s*(?:있는\s*)?(?:거|것|상품|제품)|맨\s*처음|처음\s*(?:거|것|상품|제품)?|첫째|첫\s*번째|첫번째|1\s*번째|1번|(?:둘째|두\s*번째|두번째|2\s*번째|2번)|(?:셋째|세\s*번째|세번째|3\s*번째|3번)|(?:넷째|네\s*번째|네번째|4\s*번째|4번)|(?:다섯째|다섯\s*번째|다섯번째|5\s*번째|5번)|(?:여섯째|여섯\s*번째|여섯번째|6\s*번째|6번)|(?:마지막(?![가-힣])|맨\s*아래)\s*(?:상품|제품|것|거|걸|꺼)?)(?:\s*(?:상품|제품|모델|것|거|걸|꺼))?/i.exec(s);
  if (ordinal) {
    const word = ordinal[0].replace(/\s+/g, '').toLowerCase();
    const values = [
      [/^(?:맨위|위에|맨처음|처음|첫째|첫번째|1번째|1번)/, 0],
      [/^(?:둘째|두번째|2번째|2번)/, 1],
      [/^(?:셋째|세번째|3번째|3번)/, 2],
      [/^(?:넷째|네번째|4번째|4번)/, 3],
      [/^(?:다섯째|다섯번째|5번째|5번)/, 4],
      [/^(?:여섯째|여섯번째|6번째|6번)/, 5]
    ];
    const found = values.find(([re]) => re.test(word));
    if (found) return { kind: 'ordinal', index: found[1] };
    if (/^(?:마지막|맨아래)/.test(word)) return { kind: 'last' };
  }
  const alias = /(?<![0-9A-Za-z가-힣-])([A-C])(?![0-9A-Za-z-])\s*(?:(?:은|는|이|가|을|를)\s*)?(?:(?:제품|상품|모델|가격|현재가|최저가|얼마야?|지금|다시|추천|보여줘|알려줘|사도|살까)\b|(?:제품|상품|모델|가격|현재가|최저가|얼마야?|지금|다시|추천|보여줘|알려줘|사도|살까)(?![가-힣]))/i.exec(s);
  if (alias) return { kind: 'alias', index: alias[1].toUpperCase().charCodeAt(0) - 65 };
  return null;
}

/** Parse “상품을 A라고 할게” and “이걸 B라고 부를게” alias definitions. */
function recommendationAliasDefinition(text) {
  const s = String(text == null ? '' : text).trim();
  const m = /(.+?)\s*([A-C])\s*라고\s*(?:할게|할께|부를게|부를께|하자|부르자|하겠습니다|부르겠습니다)/i.exec(s);
  if (!m) return null;
  let name = m[1].trim().replace(/(?:을|를|은|는|이|가)\s*$/, '').trim();
  if (!name) return null;
  const current = /^(?:이거|이것|이걸|이 상품|이 제품|이 모델|그거|그것|그걸|위에 거|위에 것|방금 것|아까 것)$/i.test(name);
  return { letter: m[2].toUpperCase(), name, current };
}

/**
 * 의도 판정.
 *
 * @param {string} text 사용자 발화
 * @param {Array}  [hist] 앞 대화 [{role, text}] — 검색어가 비면 앞 사용자 발화에서 이어받는다
 * @returns {{intent:'A'|'B'|'C'|'D'|'E'|'N'|'S', query:string, source:'heuristic', confidence:'high'|'low'}}
 *
 * ── confidence 의 뜻 (2026-09-02) ────────────────────────────────
 *
 *   high — 이 메시지 하나만으로 무엇을 요구하는지가 분명하다. 호출부는 LLM
 *          분류기를 건너뛴다 (요청당 LLM 호출이 그만큼 줄어든다).
 *   low  — 애매하거나 문맥이 필요하다. 호출부가 LLM 분류로 넘긴다.
 *
 * ★ 애매하면 반드시 low 다. 확신을 후하게 주면 잘못된 의도로 답하게 되고,
 *   그건 LLM 호출 한 번 아끼는 것보다 훨씬 비싸다.
 */
function classify(text, hist) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { intent: 'A', query: '', source: 'heuristic', confidence: 'high' };

  if (GREETING_RE.test(s)) return { intent: 'A', query: '', source: 'heuristic', confidence: 'high' };

  /* 상품 조건 파싱보다 먼저 정보 목적을 본다. "골라줘"가 뉴스 선별에도 쓰이기 때문이다. */
  const informationIntent = classifyInformationIntent(s);
  if (informationIntent) {
    return {
      intent: informationIntent,
      query: '',
      source: 'semantic-guard',
      confidence: 'high',
      extra: { useCase: '', brand: '', avoid: '' }
    };
  }

  /* 구매 동사보다 먼저 창작 요청인지 본다 (isCreativeRequest 주석). 검색어는 만들지 않는다. */
  if (isCreativeRequest(s)) {
    return {
      intent: 'B', query: '', source: 'heuristic', confidence: 'high', creative: true,
      contextualFollowup: false, requiresRecommendationIdentity: false, referencesKnownProduct: false,
      extra: { useCase: '', brand: '', avoid: '' }
    };
  }

  const cons = parseConstraints(s);
  const hasBudget = !!(cons.budgetMax || cons.budgetMin);
  let query = extractQuery(s);
  const reference = productReference(s);
  const aliasDefinition = recommendationAliasDefinition(s);
  const identityFollowup = reference.strong || !!(aliasDefinition && aliasDefinition.current);

  let intent;
  /*
   * explicit — 문장에 "무엇을 해 달라"는 요구 표현이 실제로 있었는가.
   *
   * ★ 조건만 있는 말(예산·취향·선물)은 explicit 이 아니다.
   *
   *   실측으로 잡은 사고: "통화 품질도 중요해" 는 PRIORITY_RE 의 '품질' 에
   *   걸려 C 가 되고, extractQuery 가 "통화 품질 중요해" 를 검색어로 만들었다.
   *   이건 후속 조건이지 새 품목이 아니다. 그대로 확신 높음으로 처리하면
   *   쿠팡에 "통화 품질 중요해" 를 검색하게 된다.
   *
   *   조건만 던지는 말은 거의 언제나 앞 대화를 이어받는 발화다. 그 해석은
   *   앞뒤를 읽는 LLM 쪽이 낫다 — 확신을 낮춰 그쪽으로 넘긴다.
   */
  let explicit = false;
  if (TIMING_RE.test(s)) { intent = 'E'; explicit = true; }
  else if (PRICE_RE.test(s)) { intent = 'D'; explicit = true; }
  /*
   * 확정된 상품을 가리키면서 값만 묻는 말 (2026-10-08 변형 공격).
   *
   * PRICE_RE 는 값 낱말에 요청 동사가 붙은 꼴을 본다("가격 알려줘"). 그래서
   * "그것 가격" · "그 제품 가격" · "첫 번째 상품 가격" 처럼 동사가 없는 꼴이
   * KNOWLEDGE_RE 로 흘러 지식 질문(B)이 됐다. B 경로에는 상품 데이터가 실리지
   * 않으므로, 참조로 되살릴 수 있는 상품이 있어도 아무 말도 못 한다
   * (실측 40개 참조 변형 중 3개가 그렇게 빈손이었다).
   *
   * 가리키는 대상이 있고 값을 물으면 그것은 그 상품의 가격 질문이다.
   */
  else if ((identityFollowup || reference.weak) && REFERENCED_PRICE_RE.test(s)) {
    intent = 'D'; explicit = true;
  }
  else if (identityFollowup) { intent = 'C'; explicit = true; }
  // "어떻게 골라야 해" 는 고르는 방법을 묻는 지식 질문이다 — 추천 요청보다 먼저 본다
  // (api/ai.js CLASSIFY_SYSTEM: "어떻게 고르나"는 B, "골라 줘"는 C).
  else if (HOWTO_RE.test(s)) { intent = 'B'; explicit = true; }
  else if (RECOMMEND_RE.test(s)) { intent = 'C'; explicit = true; }
  // 조건만 있는 말 — 갈래는 C 로 보되 확신은 주지 않는다 (위 주석).
  else if (hasBudget || cons.gift || cons.priority) intent = 'C';
  else if (ARITH_EQUATION_RE.test(s)) { intent = 'B'; explicit = true; }
  else if (KNOWLEDGE_RE.test(s)) { intent = 'B'; explicit = true; }
  else if (query && s.length <= 30) intent = 'C';   // 품목만 던진 짧은 말
  else intent = 'B';

  /*
   * 검색어가 비었으면 앞 대화의 사용자 발화에서 이어받는다.
   *   "무선 이어폰 추천해줘" → "10만원 이하로" ← 여기서 물건 이름이 없다.
   * 이어받을 것이 없으면 빈 검색어로 둔다(호출부가 품목을 되묻는다).
   */
  const ownQuery = !!query;   // 이 메시지 자체에서 뽑은 검색어인가
  /*
   * 확정된 상품을 가리키는 말도 문맥 의존 발화다. 검색어를 문맥에서 풀어야
   * 하는 것은 같고, 다른 점은 «무엇으로 푸는가» 다 — 문자열이 아니라 서버가
   * 보증한 식별자로 푼다(productReference 머리 주석, api/ai.js).
   */
  const contextualFollowup = CONTEXT_DEPENDENT_RE.test(s) || reference.strong || reference.weak
    || !!(aliasDefinition && aliasDefinition.current);
  let inheritedProductQuery = false;
  if ((!query || contextualFollowup) && intent !== 'A' && intent !== 'B' && Array.isArray(hist)) {
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i];
      if (!h || h.role === 'assistant') continue;
      const previousText = String(h.text || h.content || '').trim();
      // Do not turn a prior constraint or another pronoun question into a product query.
      if (!previousText || CONTEXT_DEPENDENT_RE.test(previousText)) continue;
      const previous = classify(previousText, []);
      if (['C', 'D', 'E'].includes(previous.intent)
          && previous.confidence === 'high' && previous.query) {
        query = previous.query;
        inheritedProductQuery = true;
        break;
      }
    }
  }

  if (intent === 'A' || intent === 'B') query = '';

  /*
   * 확신도.
   *
   *   높음 = 요구 표현이 분명하고(explicit), 문맥 의존어가 없고,
   *          상품이 필요한 의도라면 이 메시지 자체에서 검색어가 나왔다.
   *
   * 검색어를 앞 대화에서 이어받은 경우는 낮음이다. 이어받기 규칙이 맞을
   * 때도 많지만, 화제가 바뀐 대화에서는 엉뚱한 물건을 검색하게 된다
   * (실측 사고: 이어폰 대화 중 "용도는 러닝" → 러닝화). 그 판단은
   * 앞뒤를 읽는 LLM 쪽이 낫다.
   */
  let confidence = 'low';
  if (explicit && !CONTEXT_DEPENDENT_RE.test(s)) {
    if (intent === 'A') confidence = 'high';
    else if (intent === 'B') confidence = 'high';
    else if (ownQuery) confidence = 'high';
  }
  // Re-search a recognized follow-up using only the user's prior search phrase.
  // Product, option, price, and history facts still come from the server results.
  if (DETERMINISTIC_CONTEXT_FOLLOWUP_RE.test(s) && inheritedProductQuery && ['C', 'D', 'E'].includes(intent)) {
    confidence = 'high';
  }
  if (contextualFollowup && !inheritedProductQuery) query = '';

  return {
    intent, query, source: 'heuristic', confidence, contextualFollowup,
    requiresRecommendationIdentity: identityFollowup,
    referencesKnownProduct: reference.weak,
    recommendationTarget: reference.target,
    /*
     * LLM 이 뽑던 조건 중 정규식으로 확실한 것만 채운다 (extractUseCase 주석).
     * brand·avoid 는 표현이 너무 열려 있어 만들지 않는다 — 지어내느니 비운다.
     * 형태는 api/ai.js 가 mergeConstraints 에 그대로 넘길 수 있게 맞춘다.
     */
    extra: { useCase: extractUseCase(s), brand: '', avoid: '' }
  };
}

module.exports = {
  classify, classifyInformationIntent, extractQuery, extractUseCase, isCreativeRequest, productReference,
  recommendationTarget, recommendationAliasDefinition, MAX_QUERY_TOKENS, MAX_QUERY_LEN
};
