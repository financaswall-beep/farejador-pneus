'use strict';

const { createHash } = require('node:crypto');
const BATCH = 'catalog-fitment-research-20260906-v1';
const CHECKED_AT = '2026-09-06T00:00:00Z';

function stableId(value) {
  const chars = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Apenas cruzamento para REVISÃO. Esta chave nunca homologa construção ou SKU.
function nominalKey(value) {
  const text = String(value).trim().toUpperCase();
  const metric = text.match(/^(\d+)\/(\d+)(?:ZR|R|B|-)(\d+)$/);
  if (metric) return `metric:${metric[1]}:${metric[2]}:${metric[3]}`;
  const inch = text.match(/^(\d+\.\d+)-(\d+)$/);
  return inch ? `inch:${inch[1]}:${inch[2]}` : null;
}

function explicitYears(reference) {
  const match = reference.match(/^(\d{4})(?:[–-](\d{4}))?$/);
  if (!match) return { year_start: null, year_end: null };
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (start < 1900 || end < start || end > 2100) throw new Error('invalid_research_years');
  return { year_start: start, year_end: end };
}

function sourceIssue(row) {
  if (row.market !== 'Brasil') return 'referencia_internacional';
  if (row.status !== 'Medida confirmada na fonte') return row.status;
  return null;
}

function planResearchImport(applications, products) {
  const candidates = [];
  const skipped = [];
  const seen = new Set();
  for (const row of applications) {
    if (!['Dianteiro', 'Traseiro'].includes(row.position)) throw new Error('invalid_research_position');
    const url = new URL(row.url);
    if (url.protocol !== 'https:') throw new Error('invalid_research_source');
    const key = nominalKey(row.measure);
    if (!key) throw new Error('invalid_research_measure');
    const sourceKey = `${row.id}:${row.position}:${row.measure}`;
    if (seen.has(sourceKey)) throw new Error('duplicate_research_application');
    seen.add(sourceKey);
    const issue = sourceIssue(row);
    const matches = products.filter(p => nominalKey(p.tire_size) === key)
      .sort((a, b) => a.tire_spec_id.localeCompare(b.tire_spec_id));
    const record = { source_key: sourceKey, research: row, products: matches };
    if (issue || !matches.length) {
      skipped.push({ ...record, reason: issue || 'sem_produto_cadastrado_na_medida' });
    } else {
      candidates.push({ ...record, years: explicitYears(row.ref),
        position: row.position === 'Dianteiro' ? 'front' : 'rear' });
    }
  }
  return { batch: BATCH, candidates, skipped, total: applications.length };
}

function evidence(candidate) {
  const r = candidate.research;
  return [
    'CANDIDATA PARA REVISÃO, NÃO HOMOLOGADA PARA VENDA.',
    `${r.brand} ${r.model}. Referência de ano/versão: ${r.ref}. Mercado: ${r.market}.`,
    `${r.position}: ${r.measure}; índice: ${r.index}; montagem: ${r.mount}; construção: ${r.construction}.`,
    `Fonte: ${r.type}. ${r.notes || ''} ${r.alternative || ''}`,
    'Cruzamento somente por dimensão nominal, não comprova que os produtos desta medida servem.',
    'Antes de aprovar: conferir modelo comercial e posição de CADA pneu, construção, carga, velocidade, montagem e ano/versão da moto. Ano não delimitado NÃO significa todos os anos.',
    'A aprovação atual do painel propaga para produtos da mesma medida; não aprovar em lote sem validar cada produto.',
  ].join(' ').slice(0, 2000);
}

async function loadCatalog(client, environment) {
  const products = await client.query(`SELECT p.id product_id,ts.id tire_spec_id,p.product_code,
    p.product_name,p.brand,p.tire_condition,ts.tire_size,ts.position,ts.construction,
    ts.load_index,ts.speed_rating,ts.tread_pattern
    FROM commerce.products p JOIN commerce.tire_specs ts
      ON ts.product_id=p.id AND ts.environment=p.environment
    WHERE p.environment=$1 AND p.product_type='tire' AND p.deleted_at IS NULL
    ORDER BY ts.id`, [environment]);
  return products.rows;
}

async function findOrCreateVehicle(client, environment, candidate) {
  const r = candidate.research;
  const { year_start: start, year_end: end } = candidate.years;
  // Sem fuzzy match: não alarga faixas existentes nem funde ABS/CBS, Fan/Titan etc.
  const exact = await client.query(`SELECT id FROM commerce.vehicle_models
    WHERE environment=$1 AND vehicle_type='motorcycle' AND make=$2 AND model=$3
      AND variant IS NULL AND year_start IS NOT DISTINCT FROM $4::int
      AND year_end IS NOT DISTINCT FROM $5::int AND deleted_at IS NULL
    ORDER BY id LIMIT 1 FOR UPDATE`, [environment, r.brand, r.model, start, end]);
  if (exact.rows[0]) return { id: exact.rows[0].id, created: false };
  const id = stableId(`${environment}:${BATCH}:vehicle:${r.brand}:${r.model}:${r.ref}`);
  await client.query(`INSERT INTO commerce.vehicle_models
    (id,environment,vehicle_type,make,model,variant,year_start,year_end)
    VALUES ($1,$2,'motorcycle',$3,$4,NULL,$5,$6)`, [id, environment, r.brand, r.model, start, end]);
  await audit(client, environment, id, 'commerce.vehicle_models',
    'catalog_research_vehicle_created', { make: r.brand, model: r.model,
      year_start: start, year_end: end, source_reference: r.ref, source_url: r.url });
  return { id, created: true };
}

async function audit(client, environment, id, table, event, payload) {
  await client.query(`INSERT INTO audit.events
    (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
    VALUES ($1,'catalog',$2,$3,$4,'Importação de pesquisa autorizada pelo proprietário',$5::jsonb)`,
  [environment, table, id, event, JSON.stringify({ ...payload, batch: BATCH })]);
}

// O chamador controla BEGIN/COMMIT/ROLLBACK. Nenhuma escrita em produtos,
// especificações, fitments homologados, estoque, preços, pedidos ou raw/core.
async function insertPendingResearch(client, environment, plan) {
  if (!['prod', 'test'].includes(environment)) throw new Error('invalid_environment');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`catalog-research:${environment}:${BATCH}`]);
  const result = { discoveries_created: [], vehicles_created: [], already_imported: [] };
  for (const candidate of plan.candidates) {
    const id = stableId(`${environment}:${BATCH}:discovery:${candidate.source_key}`);
    const existing = await client.query(`SELECT id,environment FROM commerce.fitment_discoveries
      WHERE id=$1`, [id]);
    if (existing.rows[0]) {
      if (existing.rows[0].environment !== environment) throw new Error('import_environment_collision');
      result.already_imported.push(id);
      continue;
    }
    const vehicle = await findOrCreateVehicle(client, environment, candidate);
    if (vehicle.created) result.vehicles_created.push(vehicle.id);
    const product = candidate.products[0];
    const r = candidate.research;
    const summary = evidence(candidate);
    await client.query(`INSERT INTO commerce.fitment_discoveries
      (id,environment,vehicle_model_id,tire_spec_id,position,status,discovery_origin,
       source_url,source_title,source_checked_at,evidence_summary,
       suggested_is_oem,suggested_confidence_level,notes)
      VALUES ($1,$2,$3,$4,$5,'pending','web_research',$6,$7,$8,$9,false,0,$10)`,
    [id, environment, vehicle.id, product.tire_spec_id, candidate.position, r.url,
      `${r.brand} ${r.model} — ${r.ref}`.slice(0, 300), CHECKED_AT, summary,
      `${BATCH}; ${candidate.source_key}; sem aprovação automática; especificações dos produtos pendentes`]);
    await audit(client, environment, id, 'commerce.fitment_discoveries',
      'catalog_fitment_candidate_created', { product_id: product.product_id,
        tire_size: product.tire_size, original_measure: r.measure,
        vehicle_model_id: vehicle.id, position: candidate.position, source_url: r.url,
        evidence_summary: summary, status: 'pending', automatic_promotion: false,
        source_key: candidate.source_key, nominal_candidate_product_codes: candidate.products.map(p => p.product_code) });
    result.discoveries_created.push(id);
  }
  return result;
}

module.exports = { BATCH, stableId, nominalKey, explicitYears, planResearchImport,
  evidence, loadCatalog, insertPendingResearch };
