'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { confirmed, pending } = require('../data/catalog-tire-spec-review-20260909.cjs');

test('revisão da etapa 4 cobre os 49 pneus sem duplicidade', () => {
  const reviewed = [...confirmed, ...pending];
  assert.equal(reviewed.length, 49);
  assert.equal(new Set(reviewed.map((row) => row.productCode)).size, 49);
});

test('fichas confirmadas têm fonte oficial e dados técnicos completos', () => {
  assert.equal(confirmed.length, 4);
  for (const row of confirmed) {
    assert.match(row.sourceUrl, /^https:\/\//);
    assert.ok(row.treadPattern);
    assert.match(row.loadIndex, /^\d{2,3}$/);
    assert.match(row.speedRating, /^[A-Z]$/);
    assert.ok(['front', 'rear', 'both'].includes(row.position));
  }
});
