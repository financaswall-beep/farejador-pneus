import type { PoolClient } from 'pg';
import candidates from './data/catalog-candidates-20260911.json' with { type: 'json' };
import { matchCatalogApplications } from '../src/shared/vehicle-application-catalog.js';
import { APPLICATION_BATCH, verifiedMotorcycleImport, type ApplicationImportRow } from '../src/shared/vehicle-application-import-verified.js';

export { APPLICATION_BATCH, type ApplicationImportRow };
export function buildApplicationImport(): ApplicationImportRow[] {
  const entries = verifiedMotorcycleImport();
  const verified = entries.map(e => e.application);
  for (const row of candidates.rows) {
    const years = row.years.match(/^(\d{4})(?:[–-](\d{4}))?$/);
    const start = years ? Number(years[1]) : null;
    const end = years ? Number(years[2] ?? years[1]) : null;
    const cleanModel = row.model.replace(/\s+inclui\s+.+$/i, '').trim();
    const [make, ...modelTokens] = cleanModel.split(' ');
    const matches = matchCatalogApplications(verified, cleanModel, undefined, row.position as 'front' | 'rear')
      .filter(a => a.display_measure === row.measure);
    const covered = start !== null && end !== null && Array.from({length:end-start+1},(_,i)=>start+i)
      .every(year => matches.some(a => a.year_start !== null && a.year_end !== null
        && a.year_start<=year && a.year_end>=year));
    if (covered && row.claimed_source === 'Fabricante') continue;
    const rejected = ['Não serve','Conflito'].includes(row.claimed_source)
      || (/PCX 150/.test(row.model) && ['100/80-14','120/70-14'].includes(row.measure))
      || (/Fazer 150/.test(row.model) && row.measure === '80/100-18');
    const reason = /PCX 150/.test(row.model) && rejected
      ? 'Faixa integral recusada: PCX 2015 usa 90/90-14 dianteiro e 100/90-14 traseiro. Não estender a geração posterior a 2013–2018.'
      : /Fazer 150/.test(row.model) && row.measure === '80/100-18'
        ? 'Manual brasileiro YS150 2015/2016 especifica dianteiro 2.75-18. Não converter polegadas automaticamente em 80/100-18.'
        : row.claimed_source === 'Alternativa' ? 'Substituição de balcão; não é indicação automática do bot.'
          : matches.length ? 'Existem referências confirmadas, mas elas não comprovam toda a faixa/versões proposta nesta linha.'
            : 'A lista não traz comprovação suficiente de medida, versão brasileira e vigência. Pendente de revisão; bot não utiliza esta proposta.';
    entries.push({ status: rejected ? 'rejected' : 'pending',
      kind: row.claimed_source === 'Alternativa' ? 'alternative' : 'unknown', reviewNote: reason,
      application: { application_id: row.id, make: make!, model: modelTokens.join(' '),
        aliases: [], position: row.position as 'front' | 'rear',
        tire_size: /\d\/\d.*(?:R|ZR)/.test(row.spec) ? row.spec : row.measure,
        display_measure: row.measure, year_start:start, year_end:end, year_reference:row.years,
        reference_model:row.model, reference_year_start:start, reference_year_end:end,
        range_source_urls:[], index_spec:null, mounting:'Não conferida', source_url:'',
        source_type:`Lista recebida — ${row.claimed_source}`, source_checked_at:'2026-09-11',
        notes:row.note, validation_scope:'manufacturer_measure', product_fitment_confirmed:false },
    });
  }
  return entries;
}

export async function importVehicleApplications(client: PoolClient, environment: 'prod' | 'test') {
  const plan = buildApplicationImport();
  let inserted = 0;
  for (const { application: a, status, kind, reviewNote } of plan) {
    const result = await client.query(`INSERT INTO commerce.vehicle_measure_applications
      (environment,application_id,make,model,aliases,position,tire_size,display_measure,
       year_start,year_end,status,application_kind,reference,review_note,import_batch,vehicle_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)
      ON CONFLICT (environment,application_id) DO NOTHING`,
    [environment,a.application_id,a.make,a.model,a.aliases??[],a.position,a.tire_size,a.display_measure,
      a.year_start,a.year_end,status,kind,JSON.stringify(a),reviewNote,APPLICATION_BATCH,a.vehicle_type ?? null]);
    inserted += result.rowCount ?? 0;
  }
  return {planned:plan.length, inserted, verified:plan.filter(r=>r.status==='verified').length,
    pending:plan.filter(r=>r.status==='pending').length, rejected:plan.filter(r=>r.status==='rejected').length};
}
