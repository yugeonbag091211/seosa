'use strict';
// Test-only preload: shifts the process clock by SEOSA_TEST_CLOCK_SHIFT_DAYS
// so fixed-date fixtures that would become «time bombs» fail today, not later.
//   node --require ./scripts/ai-v34/clock-shift.js scripts/test-x.js
// Never loaded by api/ code.
const days = Number(process.env.SEOSA_TEST_CLOCK_SHIFT_DAYS || 0);
if (Number.isFinite(days) && days !== 0) {
  const offset = days * 86400000;
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(realNow() + offset);
      else super(...args);
    }
    static now() { return realNow() + offset; }
  }
  globalThis.Date = ShiftedDate;
}
