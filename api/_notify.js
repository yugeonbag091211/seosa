'use strict';
/*
 * 알림 디스패처
 * 채널을 추가하려면 _channel/ 폴더에 파일을 만들고 아래 CHANNELS에 등록하면 됩니다.
 *
 * send(channel, payload) → Promise<{ok, error?}>
 */

const CHANNELS = {
  email:   require('./_channel/email'),
  // kakao:   require('./_channel/kakao'),   // 나중에 추가
  // push:    require('./_channel/push'),     // 나중에 추가
  // discord: require('./_channel/discord'),  // 나중에 추가
};

async function send(channel, payload) {
  const ch = CHANNELS[channel];
  if (!ch) return { ok: false, error: '지원하지 않는 채널: ' + channel };
  return ch.send(payload);
}

module.exports = { send };
