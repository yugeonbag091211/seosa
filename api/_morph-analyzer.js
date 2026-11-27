/**
 * 한국어 형태소 분석기 (Kiwi) 래퍼.
 *
 * 왜 필요한가: _search.js 의 글자 매칭은 "낱말 조각이 상품명 어딘가에 붙어
 * 있으면 맞은 것으로 친다"는 방식이라, "케이스"가 "스테어케이스"(계단) 안에
 * 우연히 들어있어도 매칭돼버리는 문제가 있다. 반면 "햇빛가리개"는 "햇빛"과
 * "가리개"라는 진짜 두 낱말이 합쳐진 거라 "햇빛"만 검색해도 맞아야 한다.
 * 텍스트만 봐서는 이 둘을 구별할 수 없고, 실제 사전 기반 형태소 분석이 필요하다.
 *
 * 왜 _search.js 에 직접 넣지 않았는가: _search.js 는 ai.js, cron.js, init.js 등
 * 거의 모든 API 함수가 require 하는 핵심 모듈이다. 여기에 키위(모델 파일만
 * ~90MB)를 직접 물리면 검색과 무관한 함수들까지 전부 번들이 커지고 콜드스타트가
 * 느려진다. 그래서 이 파일은 별도 모듈로 분리하고, api/search.js 에서만
 * require 해서 _search.js 에는 "분석기 함수를 나중에 꽂아주는" 형태(의존성
 * 주입)로만 연결한다. _search.js 자신은 이 파일의 존재를 모른다.
 *
 * 모델 파일은 bab2min/Kiwi 의 0.25.0 모델에서 꼭 필요한 것만(사투리 사전,
 * 다의어 사전, 기본 고유명사 사전 제외) 추려서 ~90MB → 번들 크기와 로딩
 * 시간을 줄였다. 테스트 결과 품질 차이는 없었다 (scripts/test-morph-analyzer.js 참고).
 */

const path = require('path');
const fs = require('fs');

const MODEL_DIR = path.join(__dirname, 'kiwi-model');
const MODEL_FILE_NAMES = [
  'combiningRule.txt',
  'cong.mdl',
  'contraction.dict',
  'extract.mdl',
  'nounchr.mdl',
  'sj.morph',
  'typo.dict',
];

let kiwiInstance = null;
let buildPromise = null;

/** 같은 상품명을 반복 분석하지 않도록 캐시 (프로세스 생존 동안만, 상한 있음). */
const analyzeCache = new Map();
const ANALYZE_CACHE_MAX = 5000;

function cacheSet(key, value) {
  if (analyzeCache.size >= ANALYZE_CACHE_MAX) {
    const firstKey = analyzeCache.keys().next().value;
    analyzeCache.delete(firstKey);
  }
  analyzeCache.set(key, value);
}

/**
 * Kiwi 인스턴스를 준비한다. 여러 번 불러도 실제 빌드는 한 번만 일어난다
 * (콜드스타트당 한 번, 따뜻한 인스턴스에서는 캐시된 걸 즉시 반환).
 * 실패해도 throw 하지 않고 null 을 반환 — 형태소 분석은 "있으면 더 정확해지는"
 * 보조 기능이지, 검색 자체를 막아선 안 된다.
 */
async function ensureReady() {
  if (kiwiInstance) return kiwiInstance;
  if (buildPromise) return buildPromise;

  buildPromise = (async () => {
    try {
      // kiwi-nlp 는 순수 ESM 패키지라서(package.json "type":"module"),
      // CommonJS 인 이 프로젝트에서는 require() 가 아니라 동적 import() 로만
      // 불러올 수 있다. wasm 바이너리 자체는 일반 require.resolve 로 경로만
      // 얻는다 (require.resolve 는 모듈을 실행하지 않고 경로만 찾으므로
      // ESM/CJS 여부와 무관하게 동작한다).
      const { KiwiBuilder } = await import('kiwi-nlp');
      const wasmPath = require.resolve('kiwi-nlp/dist/kiwi-wasm.wasm');

      const modelFiles = {};
      for (const name of MODEL_FILE_NAMES) {
        modelFiles[name] = fs.readFileSync(path.join(MODEL_DIR, name));
      }

      const builder = await KiwiBuilder.create(wasmPath);
      const kiwi = await builder.build({
        modelFiles,
        loadDefaultDict: false,
        loadMultiDict: false,
        loadTypoDict: true,
      });
      kiwiInstance = kiwi;
      return kiwi;
    } catch (err) {
      console.error('[morph-analyzer] Kiwi 초기화 실패, 형태소 분석 없이 진행:', err && err.message);
      kiwiInstance = null;
      return null;
    }
  })();

  return buildPromise;
}

/**
 * 준비돼 있으면(ensureReady 가 이미 끝났으면) 동기적으로 형태소 분석.
 * 아직 준비 안 됐거나 실패했으면 null — 호출부는 null 을 "형태소 정보 없음,
 * 기존 방식대로"로 취급해야 한다.
 *
 * @param {string} flatText 공백 제거된 텍스트 (T.flat 과 동일한 공간)
 * @returns {Array<{str:string, position:number, length:number}>|null}
 */
function analyzeFlatSync(flatText) {
  if (!kiwiInstance || !flatText) return null;

  const cached = analyzeCache.get(flatText);
  if (cached) return cached;

  try {
    const result = kiwiInstance.analyze(flatText);
    const tokens = result.tokens.map(t => ({
      str: t.str,
      position: t.position,
      length: t.length,
    }));
    cacheSet(flatText, tokens);
    return tokens;
  } catch (err) {
    return null;
  }
}

function isReady() {
  return kiwiInstance !== null;
}

module.exports = { ensureReady, analyzeFlatSync, isReady };
