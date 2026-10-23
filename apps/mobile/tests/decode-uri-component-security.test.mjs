import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const queryStringPath = require.resolve('query-string');
const decoderPath = createRequire(queryStringPath).resolve('decode-uri-component');
const decoderPackage = JSON.parse(readFileSync(resolve(dirname(decoderPath), 'package.json'), 'utf8'));

function atLeast(version, minimum) {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

test('expo-router query-string resolves the patched decode-uri-component', () => {
  assert.ok(atLeast(decoderPackage.version, '0.5.0'),
    `query-string resolves vulnerable decode-uri-component@${decoderPackage.version}; CVE-2026-45822 requires >=0.5.0`);
});

test('patched decoder remains compatible with query-string URL parsing', async () => {
  const decoderModule = await import(pathToFileURL(decoderPath).href);
  const decode = decoderModule.default || decoderModule;
  assert.equal(typeof decode, 'function');
  assert.equal(decode('hello%20world'), 'hello world');

  const queryStringModule = await import(pathToFileURL(queryStringPath).href);
  const queryString = queryStringModule.default || queryStringModule;
  assert.equal(queryString.parse('q=hello%20world').q, 'hello world');
});
