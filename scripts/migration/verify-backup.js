#!/usr/bin/env node
'use strict';
// Offline SHA-256/size validation; does not connect to databases or infer row-count parity.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), new Writable({
    write(chunk, _encoding, callback) { hash.update(chunk); callback(); }
  }));
  return hash.digest('hex');
}
async function verify(dir, manifestPath) {
  const root = fs.realpathSync(dir);
  const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (data.version !== 1 || !Array.isArray(data.files) || data.files.length === 0) throw Error('Invalid archive manifest');
  if (!data.createdAt || Number.isNaN(Date.parse(data.createdAt))) throw Error('Missing UTC creation time');
  const seen = new Set();
  let verifiedBytes = 0;
  for (const item of data.files) {
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(item.name) || item.name === '.' || item.name === '..') throw Error('Invalid archive filename');
    if (seen.has(item.name)) throw Error('Duplicate archive filename');
    seen.add(item.name);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 1 || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256)) throw Error('Invalid archive metadata');
    const file = fs.realpathSync(path.join(root, item.name));
    if (!file.startsWith(root + path.sep)) throw Error('Archive path escapes the backup directory');
    if (!fs.statSync(file).isFile()) throw Error('Archive is not a regular file');
    const size = fs.statSync(file).size;
    if (size !== item.bytes) throw Error('Archive size mismatch: ' + item.name);
    const actual = await hashFile(file);
    if (actual.toLowerCase() !== item.sha256.toLowerCase()) throw Error('Archive SHA-256 mismatch: ' + item.name);
    verifiedBytes += size;
  }
  return {verifiedFiles: seen.size, verifiedBytes, createdAt:data.createdAt, rowCountsVerified:false};
}
if (require.main === module) {
  const dir = process.argv[2], manifest = process.argv[3];
  if (!dir || !manifest) { console.error('Usage: node scripts/migration/verify-backup.js BACKUP_DIR MANIFEST_JSON'); process.exit(2); }
  verify(dir, manifest).then(r => {
    console.log('BACKUP_INTEGRITY_OK ' + JSON.stringify(r));
    console.log('NOTE: Table row-count and live service parity still require separate source/target SQL verification.');
  }).catch(e => { console.error('BACKUP_INTEGRITY_FAILED: ' + e.message); process.exitCode = 1; });
}
module.exports = {verify};
