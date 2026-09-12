'use strict';

const { HotdealSourceAdapter } = require('../base');

class MockHotdealAdapter extends HotdealSourceAdapter {
  constructor(items) {
    super({ id: 'mock-hotdeal', label: '테스트 피드', kind: 'mock' });
    this.items = Array.isArray(items) ? items : [];
  }
  enabled() { return process.env.EXTERNAL_HOTDEAL_MOCK === '1'; }
  async fetch() { return this.items.slice(); }
}

const adapter = new MockHotdealAdapter();
adapter.MockHotdealAdapter = MockHotdealAdapter;
module.exports = adapter;
