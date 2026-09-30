# 스토어 출시 체크리스트

| 항목 | 값 / 상태 | 메모 |
|---|---|---|
| 앱 이름 | SEOSA | `app.json` `name` |
| 버전 / 빌드 | 1.0.0 / iOS buildNumber 1 · Android versionCode 1 | 올릴 때마다 둘 다 증가 (`appVersionSource: local`) |
| Bundle ID / Package | `kr.ai.seosa` | 도메인 역순. Apple·Google 콘솔에 같은 값으로 등록 |
| 아이콘 | 1024 RGB 풀블리드(알파 없음), Android adaptive(전경·배경·모노크롬) | `assets/` |
| 스플래시 | 라이트·다크 | `expo-splash-screen` 플러그인 |
| 권한 | **없음**. Android `permissions: []` + 카메라·위치·연락처·저장소·알림 차단, iOS UsageDescription 없음 | `tests/guard.test.mjs` 가 지킨다 |
| 암호화 | `usesNonExemptEncryption: false` (HTTPS 만) | |
| 개인정보처리방침 URL | ❌ 없음 | 웹은 오버레이뿐. `https://seosa.ai.kr/privacy` 같은 독립 페이지 필요 (웹 변경 — 승인 필요) |
| 이용약관 URL | ❌ 없음 | 위와 같음 |
| 고객지원 URL/메일 | ❌ 미정 | 공개 연락처 결정 필요 |
| 계정 삭제 | ❌ 서버 기능 없음 | Apple 5.1.1(v). 인증된 삭제 API(profiles·user_data·alerts·auth_codes) 필요 — 승인 필요 |
| 데이터 수집 (App Privacy / Data safety) | 이메일(로그인 시, 인증·AI 개인화), 검색어(서버 검색 처리), AI 질문(서버 처리). 추적·광고 ID 없음, 분석 SDK 없음 | 서버 측 보관 기간은 정책 문서와 맞춰야 함 |
| 제휴 고지 | 구매 링크가 있는 화면마다 표시, 마이에 쿠팡 파트너스 문구 | 웹 PR #113/#114 문구 그대로 |
| 쿠팡 파트너스 / ADPICK 앱 채널 | ❓ 확인 필요 | 두 곳 모두 새 채널(앱) 사용 가능 여부·등록 절차 |
| 심사용 계정 | 로그인 없이 전 기능 사용 가능(AI 는 게스트) | 심사 노트에 적기 |
| 푸시 | 비활성 | 켤 때: 기기 토큰 API → expo-notifications → `POST_NOTIFICATIONS` 차단 해제 |

## 빌드

```bash
npx eas-cli login
npx eas-cli build --profile preview --platform android   # 내부 배포용 APK
npx eas-cli build --profile production --platform ios
```

EAS 프로젝트 생성(`eas init`)은 Expo 계정에 프로젝트를 만든다 — 계정 소유자가 직접 실행.
