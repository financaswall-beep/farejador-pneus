const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nominalKey, explicitYears, stableId, planResearchImport, evidence }
  = require('../catalog-fitment-research.cjs');
const { assertTarget } = require('../import-catalog-fitment-research.cjs');

test('dimensões servem para localizar candidatas, sem converter polegadas', () => {
  assert.equal(nominalKey('140/70R17'), nominalKey('140/70-17'));
  assert.equal(nominalKey('180/55ZR17'), nominalKey('180/55-17'));
  assert.notEqual(nominalKey('3.00-17'), nominalKey('90/90-17'));
  assert.notEqual(nominalKey('120/80-18'), nominalKey('120/80-19'));
  assert.equal(nominalKey('pneu qualquer'), null);
});

test('não inventa ano-modelo a partir de publicação, produção ou geração', () => {
  assert.deepEqual(explicitYears('2019–2020'), { year_start: 2019, year_end: 2020 });
  assert.deepEqual(explicitYears('2026'), { year_start: 2026, year_end: 2026 });
  for (const ref of ['Não delimitado na fonte', 'Catálogo publicado em 2019',
    'Produção anunciada em 30/04/2026', 'Geração de lançamento 2024']) {
    assert.deepEqual(explicitYears(ref), { year_start: null, year_end: null });
  }
  assert.throws(() => explicitYears('2026–2025'), /invalid_research_years/);
});

test('IDs reproduzíveis e separados por ambiente', () => {
  assert.equal(stableId('test:a'), stableId('test:a'));
  assert.notEqual(stableId('prod:a'), stableId('test:a'));
  assert.match(stableId('test:a'), /^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
});

test('exige destino de produção correto e não aceita flags ambíguas', () => {
  const url = 'postgresql://postgres.beisgivepyfhgcujsqan:dummy@aws-0-sa-east-1.pooler.supabase.com:5432/postgres';
  assert.doesNotThrow(() => assertTarget(['--prod'], url));
  assert.throws(() => assertTarget([], url), /explicit_prod/);
  assert.throws(() => assertTarget(['--prod'], url.replace('beisgivepyfhgcujsqan', 'oldproject')), /unexpected/);
  assert.throws(() => assertTarget(['--prod', '--approve-all'], url), /unsupported/);
});

test('base completa preserva R/ZR/B, alternativas, fontes e bloqueios', async () => {
  const { applications, bikes } = await import('../data/catalog-fitment-research-20260906.mjs');
  assert.equal(bikes.length, 83);
  assert.equal(applications.length, 165);
  const products = [...new Set(applications.map(row => row.measure))].map((tire_size, i) => ({
    tire_size, tire_spec_id: stableId(`spec:${i}`), product_id: stableId(`product:${i}`),
  }));
  const plan = planResearchImport(applications, products);
  assert.equal(plan.candidates.length, 145);
  assert.equal(plan.skipped.length, 20);
  assert.ok(plan.skipped.every(c => c.reason !== 'sem_produto_cadastrado_na_medida'));
  assert.equal(plan.candidates.filter(c => c.research.brand === 'Mottu').length, 3);
  assert.ok(plan.candidates.some(c => c.research.measure === '150/80B16'));
  const radial = plan.candidates.find(c => c.research.measure === '140/70R17');
  assert.match(evidence(radial), /140\/70R17/);
  assert.match(evidence(radial), /NÃO HOMOLOGADA/);
  assert.match(evidence(radial), /CADA pneu/);
  assert.ok(plan.candidates.every(c => evidence(c).length <= 2000));
  assert.ok(plan.candidates.every(c => c.research.status === 'Medida confirmada na fonte'));
});

test('catálogo sem medida não gera produto fictício nem aproxima medida', async () => {
  const { applications } = await import('../data/catalog-fitment-research-20260906.mjs');
  const row = applications.find(c => c.measure === '140/70R17');
  const products = [{ tire_size: '140/80-17', tire_spec_id: 'other' }];
  const before = JSON.stringify({ row, products });
  const plan = planResearchImport([row], products);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.skipped[0].reason, 'sem_produto_cadastrado_na_medida');
  assert.equal(JSON.stringify({ row, products }), before);
  assert.throws(() => planResearchImport([row, row], products), /duplicate_research_application/);
});
