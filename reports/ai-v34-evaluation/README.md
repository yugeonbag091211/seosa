# reports/ai-v34-evaluation — 파일 안내

모든 수치는 **오프라인**(봉인된 2026-11-06 카탈로그 스냅샷 77,737행, 스크립트 플래너, 판매처·GPT 호출 0)이다. 실제 온라인 성공률이 아니다.

| 파일 | 내용 |
|---|---|
| `preregistration.json` | V001–V100 봉인: 질문/판정기/정답 생성기/코퍼스/정답 집합 sha256 (첫 엔진 실행 전, 커밋 `41d5b14`) |
| `preregistration-holdout.json` | H001–H040 봉인 (수정 전, 개별 실패 열람 전, 커밋 `652e0db`) |
| `offline-run1/` | 첫 실행: v3.3 원본(`fa172f3`) DB-first = **변경 전 기준선**, v3.4 초기(가격 유효기간+무선) DB-first/Hybrid(RRF) |
| `offline-run2/` | v3.4 중간(가드·제외어·부정 표현 수정 후) DB-first + Hybrid 3변형(expand / fuse w=1 / fuse w=0.5) — 4개 병렬 실행이라 **지연 수치 비교 불가** |
| `offline-run3/` | v3.4 V068/V070/V074/V075 수정 후 (중간) |
| `offline-final/` | **최종 코드** 개발 세트(V001–V100) DB-first / Hybrid expand — 순차 실행 |
| `holdout-final/` | **봉인 holdout 단 1회 실행** — v3.3 원본 / v3.4 DB-first / v3.4 Hybrid |
| `*.summary.json` | 판정 합계(합의·v3.4 판정기·v2 판정기), 잘못된 카드, Recall@10/20·HitRate·MRR, 지연 p50/p95, DB 질의 수 |
| `pgvector-bench-pglite.json` | 실험 E: 정확 스캔 vs HNSW vs IVFFlat (77,737 × 256) + EXPLAIN |
| `pgvector-neon-dev-check.json` | 격리 Neon 브랜치 최소 점검 (확장 버전·HNSW·recall·지연·실행계획) |
| `fastcheck-failures.json` | CI `--record` 출력(현재 실패 0) — 역사적 실패 4건은 `docs/ai-v34-oss-integration.md` |
| `review-v34-final.json` | 판정기 불일치(NEEDS_REVIEW) 수동 검토 기록 — 헤드라인 PASS_ONLY에는 반영하지 않음 |

절차상 기록: 최종 코드 확정 전에 holdout 실행을 한 번 시작했다가 **결과를 보기 전에 중단하고 산출물을 열람 없이 폐기**했다(같은 날 V078·V079·V096 수정이 남아 있었기 때문). 보고하는 holdout 수치는 최종 코드로 한 단 1회 실행이다.

재현:
```
node scripts/ai-v34/eval/preregister.js --snapshot <catalog.jsonl>            # 해시 확인(쓰기 없음)
node scripts/ai-v34/eval/run-offline.js --snapshot <catalog.jsonl> --engine v34 --strategy db-first --out <out.jsonl>
node scripts/ai-v34/eval/run-offline.js --set holdout --snapshot <catalog.jsonl> --engine v34 --strategy hybrid --pglite <pgdata> --out <out.jsonl>
node scripts/ai-v34/eval/compare-runs.js <a.jsonl> <b.jsonl> --only-diff --causes
```
스냅샷 파일(제휴 링크·이미지 없음, 23.6MB)은 저장소 밖에 둔다. sha256 `8868b5ff…744c`.
