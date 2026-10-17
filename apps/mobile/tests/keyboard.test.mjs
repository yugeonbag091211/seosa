import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const concierge = fs.readFileSync(path.join(ROOT, 'app/concierge.tsx'), 'utf8');

test('AI composer uses KeyboardAvoidingView padding on both Android and iOS', () => {
  assert.match(concierge, /<KeyboardAvoidingView[^>]*behavior="padding"/);
  assert.doesNotMatch(concierge, /behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);
  assert.match(concierge, /keyboardVerticalOffset=\{Platform\.OS === 'ios' \? 56 : 0\}/);
});
