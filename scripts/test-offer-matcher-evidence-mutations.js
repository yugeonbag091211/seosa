#!/usr/bin/env node
'use strict';
/*
 * Matcher evidence v2 의 안전장치를 하나씩 약하게 만들면 scripts/test-offer-matcher-evidence.js 가 잡는가.
 *
 * ★ 작업 트리를 바꾸지 않는다. 변형본은 OS 임시 폴더에 쓰고 상대 require 를 저장소 원본의 절대 경로로 바꾼다.
 *   원본은 LF 로 읽는다 — Windows CRLF 체크아웃에서도 변형 대상이 맞도록.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST = path.join(__dirname, 'test-offer-matcher-evidence.js');
const IDENTITY = path.join(ROOT, 'api', '_offeridentity.js');
const PROMOTION = path.join(ROOT, 'api', '_identitypromotion.js');
const abs = rel => JSON.stringify(path.join(ROOT, 'api', rel).split(path.sep).join('/'));
const rewire = src => src
  .replace("require('./_search')", `require(${abs('_search.js')})`)
  .replace("require('./_identitycore')", `require(${abs('_identitycore.js')})`)
  .replace("require('./_offeridentity')", `require(${abs('_offeridentity.js')})`);

const mutations = [
  { name: '설명 낱말 예외에서 «강한 모델번호» 조건을 뺀다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace('const desc = sharedStrongCode(A, B) ? descriptorOnlyDifference(A, B) : null;', 'const desc = descriptorOnlyDifference(A, B);'),
    expected: '짧은 계열 코드(G304)' },
  { name: '양쪽에 서로 다른 꼬리표가 있어도 무시한다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace('  if (tagsA.length && tagsB.length) return null;\n', ''),
    expected: '양쪽 꼬리표가 서로 다르면' },
  { name: '다른 낱말을 전부 설명 낱말로 본다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace('const covered = (list, tags) => list.every(w => DESCRIPTOR_WORDS.has(w) || tags.includes(w));', 'const covered = () => true;'),
    expected: '설치 형태' },
  { name: 'CPU 를 계열만 비교한다 (270HX = 270HXPlus)', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace('const compatible = (x, y) => x.family === y.family && (!x.model || !y.model || x.model === y.model);', 'const compatible = (x, y) => x.family === y.family;'),
    expected: 'cpu_mismatch' },
  { name: '계열만 적은 CPU 를 정확한 CPU 로 친다 (cpu_detail 제거)', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace("    else if (Boolean(a[0].model) !== Boolean(b[0].model)) unknown.push('cpu_detail');\n", ''),
    expected: 'CPU 가 계열만이면 REVIEW' },
  { name: 'GPU 충돌을 지운다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace("if (!A.gpu.some(g => B.gpu.includes(g))) conflicts.push(['gpu_mismatch', fmt(A.gpu), fmt(B.gpu)]);", 'if (false) conflicts.push([]);'),
    expected: 'gpu_mismatch' },
  { name: 'CPU·GPU 부품 분리를 끈다 (칩을 제품 모델번호로)', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace('  const comp = readComponents(s, lower);\n', '  const comp = null;\n'),
    expected: 'CPU·GPU 는 제품 모델번호가 아니다' },
  { name: '컴퓨터 RAM 보정을 끈다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace('  if (id.computer) readComputerMemory(storage, memory, specs);\n', ''),
    expected: 'RAM 32GB' },
  { name: 'CPU·GPU 를 안 적은 노트북을 컴퓨터로 보지 않는다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace('  id.computer = COMPUTER_WORD_RE.test(lower) || Boolean(comp && comp.computer);', '  id.computer = Boolean(comp && comp.computer);'),
    expected: 'CPU·GPU 를 안 적은 노트북도' },
  { name: 'i 시리즈 CPU 에 연식 같은 맨숫자를 허용한다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace('|\\\\s*(\\\\d{4,5}[a-z]{1,3}))', '|\\\\s*(\\\\d{4,5}[a-z]{0,3}))'),
    expected: '2024년형' },
  { name: '맨 «울트라 N» 을 CPU 임이 분명한 표기로 친다 (휴대폰 등급을 지운다)', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace("[/(?<![a-z0-9])(?:ultra|울트라)\\s*-?\\s*([3579])(?![0-9a-z])/g, m => `ultra${m[1]}`, 'bare'],",
      "[/(?<![a-z0-9])(?:ultra|울트라)\\s*-?\\s*([3579])(?![0-9a-z])/g, m => `ultra${m[1]}`, 'head'],"),
    expected: '애플워치 울트라 3' },
  { name: '모델번호 계열의 색 차원을 끈다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace("  id.modelNumbers.forEach(c => { if (!CHIP_CODE_RE.test(c)) keys.push(`code:${c}|${part}`); });\n", ''),
    expected: '양쪽 색 미표기' },
  { name: '여러 색이 읽히는 판매 글도 색 차원의 근거로 센다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace("if (!k.startsWith('code:') || id.colors.length === 1) id.colors.forEach(v => d.color.add(v));", 'id.colors.forEach(v => d.color.add(v));'),
    expected: '여러 색이 읽히는 판매 글 하나는' },
  { name: '본품과 부속을 같은 모델번호 계열로 묶는다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace("const part = id.accessory ? id.accessoryType || 'accessory' : 'main';", "const part = 'main';"),
    expected: '부속 쌍의 문맥에는' },
  { name: '판매처 번호의 머리 글자를 낱말로 남긴다', file: IDENTITY, env: 'OFFER_IDENTITY_MODULE',
    replace: s => s.replace("  s = s.replace(/(?<![a-z0-9])[a-z](?=\\d{7,}(?!\\d))/g, ' ');\n", ''),
    expected: '판매처 번호의 일부' },
  { name: '승격 스냅숏에서 CPU·GPU 를 뺀다', file: PROMOTION, env: 'OFFER_PROMOTION_MODULE',
    replace: s => s.replace('    cpu: id.cpu && id.cpu.length ? id.cpu : undefined, gpu: id.gpu && id.gpu.length ? id.gpu : undefined\n  };\n}\n\nfunction reasonFromUnknown',
      '  };\n}\n\nfunction reasonFromUnknown'),
    expected: '노트북 스냅숏은 CPU·GPU 를 담는다' }
];

let killed = 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-matcher-mutant-'));
try {
  mutations.forEach((m, i) => {
    const original = fs.readFileSync(m.file, 'utf8').replace(/\r\n/g, '\n');
    const mutant = m.replace(original);
    if (mutant === original) throw new Error(`mutation target did not apply: ${m.name}`);
    const file = path.join(dir, `mutant-${i}.js`);
    fs.writeFileSync(file, rewire(mutant), 'utf8');
    let failure = '';
    try {
      execFileSync(process.execPath, [TEST], { cwd: ROOT, env: Object.assign({}, process.env, { [m.env]: file }), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { failure = `${String(err.stdout || '')}\n${String(err.stderr || '')}`; }
    if (!failure) throw new Error(`mutation survived: ${m.name}`);
    if (!failure.includes(m.expected)) throw new Error(`mutation failed unexpectedly (${m.name}): ${failure.slice(-1500)}`);
    killed++;
    console.log(`KILLED ${m.name}`);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`Offer matcher evidence mutations: ${killed}/${mutations.length} killed`);
if (killed !== mutations.length) process.exit(1);
