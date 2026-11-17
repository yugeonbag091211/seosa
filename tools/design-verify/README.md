# 디자인 실데이터 검증 (읽기 전용)

브랜치의 `public/` 화면을 **운영의 실제 상품·가격·이미지**로 띄워 보되,
운영 DB 에 쓰거나 유료 API 를 부르는 요청은 네트워크에 나가기 전에 막는다.

## 무엇이 나가고 무엇이 막히나

| 요청 | 처리 |
|---|---|
| `GET /api/init`, `/api/rec`, `/api/hotdeals`(목록), `/api/history`(기본·product·batch), `/api/history-batch` | `https://seosa.ai.kr` 로 전달 (DB 읽기만 — 핸들러에 insert/upsert/update 없음, 2026-11-17 코드 확인) |
| `GET /api/search?keyword=X` | `/api/rec?keyword=X` 로 바꿔 전달 — **저장된 상품만** 읽는다. 쿠팡/ADPICK 실시간 검색·DB 저장이 일어나지 않는다 |
| `/api/stats`(방문·검색 계수), `/api/ai`, `/api/sync`, `/api/alerts`, `/api/auth`, `/api/payment`, POST 전부, `__route=identity-review/radar` | 차단 (stats 는 204, 나머지 503) |

응답은 `<cacheDir>` 에 저장돼 같은 요청은 다시 나가지 않는다(Neon 전송량 보호).
나간 요청·막힌 요청은 `<cacheDir>/requests.log` 에 한 줄씩 남는다.

구매 버튼은 누르지 않는다(누르면 제휴 클릭으로 집계된다). 감사 스크립트는 버튼의 존재·크기만 본다.

## 실행

```bash
node tools/design-verify/readonly-server.js public 3180 .design-verify-cache
```

```bash
node tools/design-verify/shots.js http://localhost:3180 shots after jobs.json
```

`jobs.json` 은 `[{ "name", "w", "h", "path", "mobile", "full", "wait", "eval", "after" }]` 배열이다.
`eval` 에 `audit.js` 의 내용을 넣으면 섹션마다 다음을 JSON 으로 돌려준다.

- 이미지: 로드 성공/실패, 비율 왜곡(object-fit), 썸네일 밖으로 넘침
- 가격: 카드에 표시된 숫자 = API 의 `lprice`
- 구매 버튼: 링크가 있는 상품에만 활성, 높이(px)
- 제휴 고지: 섹션마다 존재·표시·문구 일치·첫 구매 버튼보다 앞(DOM 순서)

변경 전과 비교하려면 `git archive main public | tar -x -C <dir>` 로 꺼낸 `public` 을 다른 포트로 띄워 같은 jobs 를 돌린다.

## Vercel Preview 에서 직접 볼 때

Preview 는 Vercel 로그인(SSO) 뒤에 있다. 로그인해서 열면 **Preview 의 서버 함수가 그 환경변수로 실제 동작**한다.
홈을 보는 것만으로도 `/api/stats` 방문 계수가 운영 DB 에 기록될 수 있고, 검색창을 쓰면 실시간 검색(유료 API 호출 + 상품 저장)이 일어난다.
쓰기 없이 보려면 위의 로컬 읽기 전용 서버를 쓴다.
