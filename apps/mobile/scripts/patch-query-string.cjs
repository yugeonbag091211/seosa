'use strict';

// query-string@7 is CommonJS, while the fixed decode-uri-component@0.5.0
// release is ESM-only. Normalize its Node/Metro interop at install time.
// Refuse unexpected package versions or source so an upstream change is reviewed.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// npm runs lifecycle scripts from this package's root.
const appRequire = createRequire(path.resolve(process.cwd(), 'package.json'));
const queryStringPath = appRequire.resolve('query-string');
const queryStringRequire = createRequire(queryStringPath);
const queryStringPackagePath = path.resolve(path.dirname(queryStringPath), 'package.json');
const queryStringPackage = JSON.parse(fs.readFileSync(queryStringPackagePath, 'utf8'));
if (queryStringPackage.version !== '7.1.3') {
  throw new Error(`Expected query-string@7.1.3, found ${queryStringPackage.version}`);
}

const decoderPath = queryStringRequire.resolve('decode-uri-component');
const decoderPackagePath = path.resolve(path.dirname(decoderPath), 'package.json');
const decoderPackage = JSON.parse(fs.readFileSync(decoderPackagePath, 'utf8'));
if (decoderPackage.version !== '0.5.0') {
  throw new Error(`Expected patched decode-uri-component@0.5.0, found ${decoderPackage.version}`);
}

const source = fs.readFileSync(queryStringPath, 'utf8');
const original = "const decodeComponent = require('decode-uri-component');";
const replacement = [
  "const decodeComponentModule = require('decode-uri-component');",
  'const decodeComponent = typeof decodeComponentModule === \'function\'',
  '\t? decodeComponentModule',
  '\t: decodeComponentModule.default;'
].join('\n');

if (source.includes(replacement)) process.exit(0);
if (source.split(original).length !== 2) {
  throw new Error('Unexpected query-string decoder import; inspect before patching.');
}
fs.writeFileSync(queryStringPath, source.replace(original, replacement));
