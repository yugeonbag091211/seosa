import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));

test('production EAS builds use remote monotonically increasing build versions', () => {
  assert.equal(eas.cli?.appVersionSource, 'remote');
  assert.equal(eas.cli?.requireCommit, true);
  assert.equal(eas.build?.production?.autoIncrement, true);
});

test('production and internal builds keep the production API base URL', () => {
  assert.equal(eas.build?.base?.env?.EXPO_PUBLIC_API_BASE_URL, 'https://seosa.ai.kr');
  assert.equal(eas.build?.preview?.extends, 'base');
  assert.equal(eas.build?.production?.extends, 'base');
});
