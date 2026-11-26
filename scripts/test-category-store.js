#!/usr/bin/env node
/*
 * api/_category-store.js 회귀 테스트 — 실제 Supabase/OpenAI 호출 0회.
 * 가짜 DB(select/in, update/eq)와 가짜 classify() 를 주입해 검증한다.
 */
'use strict';

const {
  syncCategories, lookupCategories, DEFAULT_TIME_BUDGET_MS, DEFAULT_LOOKUP_BUDGET_MS
} = require('../api/_category-store');

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, pass: !!cond });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`, cond ? '' : JSON.stringify(detail));
}

/** 최소 기능만 흉내 내는 가짜 Supabase. products 테이블 하나만 안다. */
function fakeSupabase(rows, { selectShouldFail = false, updateShouldFail = false } = {}) {
  const updates = [];
  return {
    _updates: updates,
    from(table) {
      if (table !== 'products') throw new Error(`예상 밖 테이블: ${table}`);
      return {
        select() {
          return {
            in(col, vals) {
              if (selectShouldFail) return Promise.resolve({ data: null, error: { message: 'db down' } });
              const data = rows.filter(r => vals.includes(r[col]));
              return Promise.resolve({ data, error: null });
            }
          };
        },
        update(patch) {
          return {
            eq(col, val) {
              updates.push({ [col]: val, ...patch });
              if (updateShouldFail) return Promise.resolve({ error: { message: 'write failed' } });
              const row = rows.find(r => r[col] === val);
              if (row) Object.assign(row, patch);
              return Promise.resolve({ error: null });
            }
          };
        }
      };
    }
  };
}

(async () => {
  console.log('1. 전부 이미 분류돼 있으면 classify를 안 부른다');
  {
    const rows = [{ product_id: 'A', category: '전자기기' }, { product_id: 'B', category: '패션의류' }];
    const supabase = fakeSupabase(rows);
    let classifyCalls = 0;
    const classify = async () => { classifyCalls++; return []; };
    const map = await syncCategories(
      [{ productId: 'A', title: 'RTX 4070 그래픽카드' }, { productId: 'B', title: '트럼프카드 맨투맨' }],
      { supabase, classify }
    );
    check('classify 호출 0회', classifyCalls === 0, classifyCalls);
    check('캐시된 값 그대로 반환', map.get('A') === '전자기기' && map.get('B') === '패션의류', [...map]);
    check('DB 쓰기 없음', supabase._updates.length === 0, supabase._updates);
  }

  console.log('\n2. 처음 보는 상품만 분류해서 묻는다');
  {
    const rows = [{ product_id: 'A', category: '전자기기' }]; // B, C는 처음 봄
    const supabase = fakeSupabase(rows);
    let askedTitles = null;
    const classify = async titles => { askedTitles = titles; return titles.map(() => '패션의류'); };
    const map = await syncCategories(
      [
        { productId: 'A', title: 'RTX 4070 그래픽카드' },
        { productId: 'B', title: '트럼프카드 맨투맨' },
        { productId: 'C', title: '루이비통 자카드 후드티' }
      ],
      { supabase, classify }
    );
    check('A는 캐시, B·C만 새로 물어봄', JSON.stringify(askedTitles) === JSON.stringify(['트럼프카드 맨투맨', '루이비통 자카드 후드티']), askedTitles);
    check('세 건 다 맵에 들어감', map.get('A') === '전자기기' && map.get('B') === '패션의류' && map.get('C') === '패션의류');
    check('새로 분류한 2건만 DB에 기록', supabase._updates.length === 2, supabase._updates);
  }

  console.log('\n3. 같은 productId가 여러 번(여러 mall) 들어와도 한 번만 묻는다');
  {
    const rows = [];
    const supabase = fakeSupabase(rows);
    let callCount = 0;
    const classify = async titles => { callCount++; return titles.map(() => '전자기기'); };
    const map = await syncCategories(
      [
        { productId: 'X', title: '노트북' },
        { productId: 'X', title: '노트북' } // 다른 mall, 같은 상품
      ],
      { supabase, classify }
    );
    check('classify 1번만 호출', callCount === 1, callCount);
    check('DB 기록도 중복 없이 1건', supabase._updates.length === 1, supabase._updates);
    check('맵에는 X 하나', map.size === 1 && map.get('X') === '전자기기');
  }

  console.log('\n3b. 일부만 타임아웃나면(null) 그 상품만 캐싱 안 하고 재시도 대상으로 남긴다');
  {
    // ★ 2026-11-25 product-kind 실측 리허설과 같은 교훈을 카테고리에도 적용:
    //   9개 상품이 전부 'unknown'으로 영구 저장된 사고. null인 자리는 맵에도
    //   DB에도 안 남아야 다음 검색에서 다시 물어본다.
    const rows = [];
    const supabase = fakeSupabase(rows);
    // A는 정상 응답(main), B는 타임아웃(null), C는 GPT가 실제로 애매하다고 답함(unknown).
    const classify = async () => ['전자기기', null, 'unknown'];
    const map = await syncCategories(
      [
        { productId: 'A', title: 'RTX 4070 그래픽카드' },
        { productId: 'B', title: '트럼프카드 맨투맨' },
        { productId: 'C', title: '애매한 상품' }
      ],
      { supabase, classify }
    );
    check('타임아웃난 B는 맵에 없음(= 모른다, 안전하게 kept 유지)', !map.has('B'), [...map]);
    check('정상 응답(A)과 실제 unknown(C)은 맵에 들어감',
      map.get('A') === '전자기기' && map.get('C') === 'unknown', [...map]);
    check('DB에도 A·C 두 건만 기록(B는 재시도 대상이라 안 씀)',
      supabase._updates.length === 2 && supabase._updates.every(u => u.product_id !== 'B'),
      supabase._updates);
  }

  console.log('\n4. DB 조회 자체가 실패하면(컬럼 없음 등) 빈 맵으로 안전하게 넘어간다');
  {
    const supabase = fakeSupabase([], { selectShouldFail: true });
    let classifyCalls = 0;
    const classify = async () => { classifyCalls++; return []; };
    const map = await syncCategories([{ productId: 'A', title: 'RTX 4070 그래픽카드' }], { supabase, classify });
    check('빈 맵 반환(에러 안 던짐)', map.size === 0);
    check('classify도 안 부름(조회 단계에서 멈춤)', classifyCalls === 0);
  }

  console.log('\n5. classify()가 예외를 던져도 검색 자체는 안 죽는다');
  {
    const supabase = fakeSupabase([]);
    const classify = async () => { throw new Error('openai down'); };
    const map = await syncCategories([{ productId: 'A', title: 'RTX 4070 그래픽카드' }], { supabase, classify });
    check('빈 맵 반환', map.size === 0);
  }

  console.log('\n6. DB 쓰기가 실패해도 이번 회차 응답에는 영향 없다(맵은 정상 반환)');
  {
    const supabase = fakeSupabase([], { updateShouldFail: true });
    const classify = async titles => titles.map(() => '패션의류');
    const map = await syncCategories([{ productId: 'A', title: '트럼프카드 맨투맨' }], { supabase, classify });
    check('분류 결과는 맵에 들어있음(쓰기 실패와 무관)', map.get('A') === '패션의류');
  }

  console.log('\n7. 시간 예산을 넘기면 기다리지 않고 그냥 돌아온다 (검색이 느려지면 안 된다)');
  {
    const supabase = fakeSupabase([]);
    const classify = () => new Promise(resolve => setTimeout(() => resolve(['전자기기']), 2000)); // 2초짜리 느린 호출
    const startedAt = Date.now();
    const map = await syncCategories([{ productId: 'A', title: '아무거나' }], { supabase, classify, timeBudgetMs: 150 });
    const elapsed = Date.now() - startedAt;
    check('150ms 예산을 크게 넘기지 않고 반환', elapsed < 1000, elapsed);
    check('제때 못 받은 분류는 빈 맵(= 모른다, 안전)', map.size === 0);
  }

  console.log('\n8. 빈 입력');
  {
    const supabase = fakeSupabase([]);
    const map = await syncCategories([], { supabase, classify: async () => [] });
    check('빈 배열 → 빈 맵', map.size === 0);
  }
  check(`기본 시간 예산이 합리적 범위(1~10초)`, DEFAULT_TIME_BUDGET_MS >= 1000 && DEFAULT_TIME_BUDGET_MS <= 10000);

  console.log('\n9. lookupCategories — 손님 검색 경로: 저장된 값만 읽고 GPT는 절대 안 부른다');
  {
    const rows = [
      { product_id: 'A', category: '전자기기' },
      { product_id: 'B', category: '패션의류' }
    ];
    const supabase = fakeSupabase(rows);
    const map = await lookupCategories(['A', 'B', 'C'], { supabase }); // C는 아직 배치가 못 본 상품
    check('이미 저장된 A·B는 그대로 반환', map.get('A') === '전자기기' && map.get('B') === '패션의류', [...map]);
    check('아직 모르는 C는 맵에 없음(= 기존 사전 가드만 적용)', !map.has('C'), [...map]);
    check('update는 한 번도 호출 안 함(쓰기 없음, 읽기 전용)', supabase._updates.length === 0, supabase._updates);
  }

  console.log('\n10. lookupCategories — DB 조회 자체가 실패해도 빈 맵으로 안전하게 넘어간다');
  {
    const supabase = fakeSupabase([], { selectShouldFail: true });
    const map = await lookupCategories(['A'], { supabase });
    check('빈 맵 반환(에러 안 던짐)', map.size === 0);
  }

  console.log('\n11. lookupCategories — 시간 예산을 넘기면(DB가 느려도) 기다리지 않고 돌아온다');
  {
    // select 자체가 2초 걸리는 느린 가짜 DB — 손님 검색을 절대 묶어두면 안 된다.
    const supabase = {
      from(table) {
        if (table !== 'products') throw new Error(`예상 밖 테이블: ${table}`);
        return { select: () => ({ in: () => new Promise(resolve => setTimeout(() => resolve({ data: [], error: null }), 2000)) }) };
      }
    };
    const startedAt = Date.now();
    const map = await lookupCategories(['A'], { supabase, timeBudgetMs: 150 });
    const elapsed = Date.now() - startedAt;
    check('150ms 예산을 크게 넘기지 않고 반환', elapsed < 1000, elapsed);
    check('제때 못 받으면 빈 맵(= 모른다, 안전)', map.size === 0);
  }

  console.log('\n12. lookupCategories — 빈 입력');
  {
    const supabase = fakeSupabase([]);
    const map = await lookupCategories([], { supabase });
    check('빈 배열 → 빈 맵', map.size === 0);
  }
  check('조회 전용 기본 시간 예산이 라이브 검색에 맞게 짧다(200ms~2초)',
    DEFAULT_LOOKUP_BUDGET_MS >= 200 && DEFAULT_LOOKUP_BUDGET_MS <= 2000, DEFAULT_LOOKUP_BUDGET_MS);

  const passed = checks.filter(c => c.pass).length;
  const failed = checks.length - passed;
  console.log(`\n${'='.repeat(60)}\n상품 카테고리 캐싱 테스트: ${passed} PASS / ${failed} FAIL\n${'='.repeat(60)}`);
  if (failed) process.exit(1);
})();
