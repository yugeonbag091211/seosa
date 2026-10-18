'use strict';
/*
 * Vercel CLI preload — 한글 호스트 이름 우회.
 *
 * 이 PC 의 호스트 이름이 한글이면 Vercel CLI 가 그 이름을 HTTP 헤더에 넣다가 Node 가
 * "Cannot convert argument to a ByteString" 으로 거부한다(로그인부터 실패). CLI 프로세스에서만
 * os.hostname() 을 ASCII 로 바꾼다. 시스템 설정은 건드리지 않는다.
 *
 *   NODE_OPTIONS="--require ./scripts/_vercel-ascii-hostname.js" vercel whoami
 */
const os = require('os');
const real = os.hostname;
os.hostname = () => {
  const h = real.call(os);
  return /^[\x20-\x7e]*$/.test(h) ? h : 'seosa-dev-pc';
};
