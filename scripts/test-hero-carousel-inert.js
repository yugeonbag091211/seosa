'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const start = html.indexOf('var HeroCarousel = {');
const end = html.indexOf('\n};', start);
assert.ok(start >= 0 && end > start, 'HeroCarousel object is present');
const source = html.slice(start, end + 3) + '\nglobalThis.carousel = HeroCarousel;';
const context = {};
vm.runInNewContext(source, context, { filename: 'public/index.html#HeroCarousel' });

function makePanel() {
  const attrs = {};
  return {
    attrs,
    style: {},
    inert: false,
    classList: { on: false, toggle(name, value) { if (name === 'on') this.on = value; } },
    setAttribute(name, value) { attrs[name] = value; },
    get offsetWidth() { return 0; },
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('PASS ' + name);
}

const panel = makePanel();
check('active slide is exposed and not inert', () => {
  context.carousel.place(panel, 0, false);
  assert.equal(panel.inert, false);
  assert.equal(panel.attrs['aria-hidden'], 'false');
  assert.equal(panel.classList.on, true);
});
check('outgoing slide becomes inert before visibility transition ends', () => {
  context.carousel.place(panel, -1, true);
  assert.equal(panel.inert, true);
  assert.equal(panel.attrs['aria-hidden'], 'true');
  assert.equal(panel.style.opacity, '0');
  assert.match(panel.style.transform, /translateX\(-100%\)/);
});
check('incoming slide is restored to keyboard and accessibility trees', () => {
  context.carousel.place(panel, 0, true);
  assert.equal(panel.inert, false);
  assert.equal(panel.attrs['aria-hidden'], 'false');
  assert.equal(panel.classList.on, true);
});

console.log('[test-hero-carousel-inert] PASS ' + passed + ' / FAIL 0');