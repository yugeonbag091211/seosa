#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const kit = require('./_v2-testkit');
const { T } = kit.setup('test-v2-home-links');
const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const lab = fs.readFileSync(path.join(root, 'public/v2/index.html'), 'utf8');
const styles = home.slice(0, home.indexOf('</style>'));

const routes = [
  ['/v2/investigator.html', 'AI 쇼핑 조사관'],
  ['/v2/cart.html', '장바구니 최저가'],
  ['/v2/anomaly.html', '가격 이상 패턴']
];
for (const [route, label] of routes) {
  T.check(home.includes(`href="${route}">${label}</a>`), `홈에서 ${label}로 연결된다`);
  T.check(lab.includes(`href="${route}"`), `SEOSA 2.0 목록에서 ${label}로 연결된다`);
}
T.check(!/timing\.html|waitroom\.html|구매 타이밍 예측|구매 대기실/.test(home + lab),
  '운영 준비 전 구매 타이밍·대기실 기능은 공개하지 않는다');
T.check(!/data-label="구매 시점 판단"|구매 타이밍 확인|지금 살까|지금 사도 좋아요|>BUY</.test(home),
  '백테스트가 끝나지 않은 구매 타이밍을 홈 배너에서 권하지 않는다');
T.check(home.includes('aria-label="가격 분석 도구"'), '가격 도구 탐색에 접근 가능한 이름이 있다');
T.check(/\.v2-tools a\{[^}]*min-height:44px/s.test(styles), '도구 링크의 터치 높이가 44px 이상이다');
T.check(/\.v2-tools\{[^}]*flex-wrap:wrap/s.test(styles), '좁은 화면에서 링크가 줄바꿈된다');

T.done();

