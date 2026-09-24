# SEOSA 가격 기록 — Chrome 확장 (Manifest V3)

쿠팡 상품 페이지에서 **버튼을 누르면** SEOSA가 매일 쌓은 가격 기록, 지금 가격의 위치,
같은 상품의 다른 판매처 가격을 페이지 위 작은 패널로 보여 줍니다.
11번가 · G마켓 상품 페이지에서는 제목으로 찾은 **비슷한 상품의 기록**을 보여 줍니다.

누르기 전에는 아무것도 보내지 않습니다. 개인정보 처리는 [PRIVACY.md](PRIVACY.md)에 있습니다.

## 설치 (개발자 모드)

1. 이 저장소를 받습니다 (`git clone` 또는 ZIP 다운로드 후 압축 풀기).
2. Chrome 주소창에 `chrome://extensions` 를 엽니다.
3. 오른쪽 위 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램 로드**를 누르고 저장소의 `extension` 폴더를 고릅니다.
5. 쿠팡 상품 페이지(`https://www.coupang.com/vp/products/...`)를 열면 오른쪽 아래에
   **SEOSA 가격 기록 보기** 버튼이 생깁니다.

Chrome 102 이상에서 동작합니다. Edge·Whale 같은 Chromium 브라우저도 같은 방법으로 설치할 수 있습니다.

## 쓰는 법

| 동작 | 결과 |
|---|---|
| 버튼 누르기 | 이 상품의 기록을 불러와 패널을 엽니다. 같은 상품을 다시 열면 다시 보내지 않습니다 |
| 패널의 `×` · `Esc` | 패널을 닫습니다 |
| 패널의 **이 버튼 숨기기** | 모든 상품 페이지에서 버튼을 숨깁니다 |
| 브라우저 툴바의 확장 아이콘 | 숨긴 버튼을 다시 보이게 합니다 (한 번 더 누르면 다시 숨김) |

패널이 보여 주는 것:

- **이 상품의 기록** — 쿠팡 상품 번호가 SEOSA 카탈로그에 있을 때 (EXACT)
- **비슷한 상품의 기록** — 번호로는 없지만 제목으로 같은 상품을 찾았을 때 (SIMILAR).
  이 페이지 상품의 기록이 아니라고 분명히 적습니다. 확신이 낮으면 «확신 낮음» 을 붙입니다
- **기록 없음** — 같은 상품이라고 볼 근거가 없을 때 (NONE)
- 가격 곡선, 최근 90일 중 지금 가격의 위치, (있으면) 구매 타이밍 · 가격 이상 패턴
- 같은 상품의 다른 판매처 가격 — SEOSA HOT 과 같은 동일상품 판정을 통과한 것만
- **대기실에 등록** — SEOSA 구매 대기실에서 목표가 알림을 받을 수 있는 링크

## 구조

```
extension/
  manifest.json        MV3. 권한: storage + https://seosa.ai.kr/* 뿐
  src/parse.js         주소 · 제목 해석 (순수 함수, 브라우저·Node 공용)
  src/content.js       상품 페이지의 버튼 · 패널 (닫힌 Shadow DOM, innerHTML 없음)
  src/background.js    서비스 워커 — 메시지 검증 후 /api/lookup 한 번 호출
  README.md · PRIVACY.md
```

아이콘 파일은 넣지 않았습니다 (Chrome이 기본 아이콘을 씁니다). 웹스토어에 올릴 때
16·32·48·128px PNG를 `icons` 에 추가해야 합니다.

## 개발

- 빌드 도구가 없습니다. 파일을 고친 뒤 `chrome://extensions` 에서 새로고침(↻)만 누르면 됩니다.
- 서비스 워커 로그: `chrome://extensions` → 이 확장의 **서비스 워커** 링크.
- 콘텐츠 스크립트 로그: 상품 페이지의 개발자 도구 → Console (컨텍스트: SEOSA 가격 기록).
- 오프라인 테스트: 저장소 루트에서 `node scripts/test-v2-extension.js`
  (parse.js · manifest 권한 · 서비스 워커 · 콘텐츠 스크립트 · `/api/lookup` 을 네트워크 없이 검사합니다).
- 로컬 서버로 시험하려면 `src/background.js` 의 `LOOKUP_URL` 과 `manifest.json` 의
  `host_permissions` 를 **함께** 바꿔야 합니다. 둘 중 하나만 바꾸면 테스트가 실패합니다.

서버 쪽 계약은 [docs/seosa2/CONTRACTS.md](../docs/seosa2/CONTRACTS.md) §3 ④,
설계 기록은 [docs/seosa2/extension.md](../docs/seosa2/extension.md) 에 있습니다.
