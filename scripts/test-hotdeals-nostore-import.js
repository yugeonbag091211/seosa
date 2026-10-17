'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'api', 'hotdeals.js');
const src = fs.readFileSync(file, 'utf8');

if (!/const\s*\{[^}]*\bnoStore\b[^}]*\}\s*=\s*require\(['"]\.\/_http['"]\)/.test(src)) {
  throw new Error('api/hotdeals.js must import noStore from ./_http');
}

console.log('hotdeals noStore import: PASS');
