# 중요 오류 재현 방법

모든 재현은 운영에 **읽기 전용이 아닌 일반 사용자 요청**을 한 건 보낸다(판매처 검색·GPT 호출 발생). 상품 링크는 열지 않는다. 판매처 한도를 지키려면 20초 이상 간격을 둔다.

## A. 오프라인 재현 (호출 0회, 권장)

```bash
node -e "const I=require('./api/ai.js')._internal;const h=[{role:'user',text:'필기용 태블릿 추천해줘'},{role:'assistant',text:'x'}];for(const q of ['돈은 80만원밖에 못 써요','최종 추천 하나 궁금해','위 두 제품 중에 뭐가 나아?','신품으로만 추천해 정확히요'])console.log(q,'=>',I.heuristicIntent(q,h,{source:'none'}).query)"
```

수정 전(`718fe7f`) 결과: `돈은 밖에 써요`, `최종`, `나아`, `신품으로 정확히요`.

```bash
node -e "const {parseConstraints:p}=require('./api/_shopintent');for(const q of ['노트북 최소 120만은 줘야 쓸 만하다던데','6만원은 넘되 120,000원은 안 넘는 운동화','십삼만원 이상은 써도 되니까 헤드셋'])console.log(q,p(q).budgetMin,p(q).budgetMax)"
```

수정 전 결과: `0 1320000`, `0 132000`, `0 0`.

## B. 운영 재현

```bash
node scripts/production-ai-5000/run.js --until 200 --gap-ms 20000
```

이미 저장된 질문은 건너뛰므로, 새 결과 폴더를 쓰거나 `reports/production-ai-5000/responses.jsonl` 의 해당 줄을 옮긴 뒤 실행한다. 세션 오류(예: Q00049)는 앞 턴부터 순서대로 보내야 재현된다. 판매처 결과가 달라지면 같은 상품이 나오지 않을 수 있으나, 서버 로그의 검색어는 같다.

## C. 대화 세션 수동 재현

웹에서 대화를 지우고 차례로 입력한다.

1. `필기용 태블릿 추천해줘`
2. `돈은 80만원밖에 못 써요` → 태블릿이 아닌 카드가 나오면 재현
