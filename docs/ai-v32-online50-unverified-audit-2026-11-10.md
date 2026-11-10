# SEOSA AI v3.2 — 50-question UNVERIFIED DB audit and H47 oracle dispute
Date: 2026-11-10 (Asia/Seoul)

## Data, safety, and immutability
- Real result: `docs/ai-v32-online50-live-2026-11-10.md`, Preview `d07c345`.
- Raw 50-question classification: **34 PASS / 1 FAIL / 15 UNVERIFIED**.
- Read-only Neon `products` catalog, 77,820 rows; latest `collected_at` observed `2026-11-10T04:17:17.536Z`.
- This audit is **a supplemental post-run investigation**. Never rewrite the original 70-case pre-registered holdout label JSON, raw results, or the original 50-question report.
- Lexical catalog hits alone are not verified purchasable offers: confirm exact model, size, condition, capacity, wireless mode, and product (not accessory). A snapshot is not evidence of live inventory or actual checkout price.

## Original 15 UNVERIFIED rows: adjudication as of catalog snapshot
| ID | Query/constraint | Read-only DB evidence | Supplemental status |
|---|---|---|---|
| H11 | Galaxy Tab S10 FE Plus, 256GB, Wi-Fi | FE (non-Plus) 256GB Wi-Fi listings, plus 128/256GB multi-option Plus listing without the priced 256GB Wi-Fi option | OPTION_AND_NETWORK_UNVERIFIED |
| H13 | Redmi Pad Pro 300k band | No Redmi Pad Pro full device in 300,000–399,999 KRW in inspected catalog | NO_ELIGIBLE_LISTING_FOUND |
| H14 | iPad Air 13 M3 | Cases, multi-generation accessories, and a seller title mixing M2 device with M3 variant mention | NO_VERIFIED_EXACT_DEVICE |
| H15 | 8-inch tablet up to 200k | Search hits were drum practice pads and Galaxy Tab 8.7-inch compatible *cases* | NO_VERIFIED_EXACT_DEVICE |
| H16 | Z Flip6 256GB unlocked | Only inspected full device is explicitly refurbished (`S리퍼`), not a new unlocked phone | NO_VERIFIED_NEW_DEVICE |
| H17 | iPhone 15 128GB new unlocked | Inspected 128GB listing is iPhone 15 **Plus**, not base model | NO_VERIFIED_EXACT_DEVICE |
| H21 | LG Gram 16-inch 2024 under 1.5M | Keyboard skins, screen protectors, and wraps; no complete suitable laptop | NO_ELIGIBLE_LISTING_FOUND |
| H22 | RTX 4060 laptop under 1.5M | Inspected low-price RTX4060 hits were stand-alone GPUs, not laptops | NO_ELIGIBLE_LISTING_FOUND |
| H23 | MacBook Air M2 13-inch 256GB | No exact matching full device in read-only catalog search | NO_ELIGIBLE_LISTING_FOUND |
| H25 | Chromebook under 300k | Hits were Chromebook-compatible adapters/chargers only | NO_ELIGIBLE_LISTING_FOUND |
| H26 | Samsung T7 1TB SSD under 150k | Hit was EVA **protective case** for T7/T9 devices, not SSD | NO_VERIFIED_EXACT_DEVICE |
| H27 | Seagate Expansion 2TB external HDD | One 500GB/1TB/2TB multi-option listing at 19,000 KRW; 2TB price and SKU cannot be proved | CAPACITY_OPTION_PRICE_UNVERIFIED |
| H40 | Wireless left-handed mouse under 30k | **Real eligible lexical evidence exists:** Logitech M170 wireless ambidextrous/symmetrical, 12,900 KRW (2026-11-06), another M170 15,650 KRW; older broad 40-row search missed them; wired M90 and multi-price wired/wireless options excluded | **RETRIEVAL_MISS_CONFIRMED** |
| H46 | Dyson Pure Cool line | No verified Pure Cool line full device; other Dyson air purifier families do not qualify | NO_VERIFIED_EXACT_DEVICE |
| H56 | Kids calling smartwatch under 100k | No verified kids calling smartwatch in price window; ordinary adult Bluetooth watches do not satisfy | NO_ELIGIBLE_LISTING_FOUND |

Summary: **1 confirmed retrieval miss (H40)**, **2 SKU/option-price unresolved (H11,H27)**, **12 with no confirmed eligible item in inspected catalog**. The last category is not a proof of market unavailability.

## H47: preregistered benchmark oracle disagreement (outside the 15)
- User asked: `로보락 S8 로봇청소기 가격 비교`. Exact bare S8 model.
- Frozen pre-registered label: `FIND`, with note explicitly `S8 family only (S8 Pro / Pro Plus / MaxV Ultra); no plain S8`.
- Read-only Neon: full-device rows for **S8 Pro (419,000 KRW), S8 Pro Plus (468,990 KRW), and S8 MaxV Ultra**; search also inspected accessories, but no confirmed plain S8 base model.
- Strict v3.2 model validation rejected 31 candidates (30 wrong model; 1 used), returning no cards.
- **Supplemental adjudication:** `BASE_S8_NOT_CONFIRMED / ORACLE_FIND_DISPUTED`; retain strict model guard and original test verdict **FAIL (1)** until separately reviewed. Do **not** count H47 as newly passing without a new, pre-registered benchmark.

## Code action
- v3.2 read-only probe planner now searches positive left-hand/symmetric/ambidextrous ergonomic synonyms *before* generic 40-row mouse listings. The actual final listing must still pass type, wireless, handedness, budget, and option price checks.
- Price band parser corrected: `30만원대` = 300k–399,999, `10만원대` = 100k–199,999; `15만원대` = 150k–159,999; exact ceilings unchanged. Prior `30만원대` parsing 300k–309,999 was too narrow.
- Regression suite `scripts/test-ai-v32-h40-retrieval-20261110.js` uses in-memory read-only catalog with 70 newer generic mouse rows and a real-titled older M170. It confirms the retrieval planner finds M170 beyond the first 40 generic rows. **Offline test only**.
- Never promote the production service until the new code passes a real Preview search (H40 + control), stable independent holdout and all CI.

## Sources
- First-party Neon SQL SELECT only; no DB writes; no seller website live purchase verification.
- Source test corpus: `scripts/ai-v32-eval/holdout-cases.js`, frozen labels `scripts/ai-v32-eval/holdout-labels.json`, online 50 original report.
