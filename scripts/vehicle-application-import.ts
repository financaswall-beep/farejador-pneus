import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import manuals from './data/catalog-manual-review-20260911.json' with { type: 'json' };
import candidates from './data/catalog-candidates-20260911.json' with { type: 'json' };
import { manufacturerApplicationSeed, applicationMeasureKey } from '../src/shared/vehicle-tire-applications.js';
import { matchCatalogApplications, type CatalogApplication } from '../src/shared/vehicle-application-catalog.js';

export const APPLICATION_BATCH = 'catalog-measure-applications-20260911-v1';
export interface ApplicationImportRow {
  application: CatalogApplication;
  status: 'verified' | 'pending' | 'rejected';
  kind: 'original' | 'alternative' | 'unknown';
  reviewNote: string;
}
const idFor = (key: string) => `review-20260911:${createHash('sha256').update(key).digest('hex').slice(0,24)}`;

export function buildApplicationImport(): ApplicationImportRow[] {
  const entries: ApplicationImportRow[] = [];
  const buckets = new Map<string, typeof manuals.observations>();
  for (const row of manuals.observations) {
    const model = row.model.replace(' (SMART KEY)', '');
    const key = JSON.stringify([model, row.position, row.tire_size, row.index_spec, row.mounting]);
    const list = buckets.get(key) ?? [];
    if (!list.some(r => r.year === row.year)) list.push({ ...row, model });
    buckets.set(key, list);
  }
  for (const [key, observations] of buckets) {
    const ordered = observations.sort((a,b) => a.year-b.year);
    const runs: typeof ordered[] = [];
    for (const observation of ordered) {
      const last = runs.at(-1);
      if (last && last.at(-1)!.year + 1 === observation.year) last.push(observation);
      else runs.push([observation]);
    }
    for (const run of runs) {
      const first = run[0]!, last = run.at(-1)!;
      const aliases = /CROSSER/.test(first.model) ? ['XTZ 150 Crosser', 'Crosser 150 S Z']
        : /FZ25/.test(first.model) ? ['Fazer 250 FZ25', 'Fazer FZ25 250']
          : /YS150/.test(first.model) ? ['Fazer 150 YS 150']
            : /FLUO/.test(first.model) ? ['Fluo 125 ABS'] : ['NMAX 160'];
      const application: CatalogApplication = {
        application_id: idFor(`${key}:${first.year}:${last.year}`), make: first.make, model: first.model,
        aliases, position: first.position as 'front' | 'rear', tire_size: first.tire_size,
        display_measure: applicationMeasureKey(first.tire_size), index_spec: first.index_spec,
        mounting: first.mounting, year_start: first.year, year_end: last.year,
        year_reference: first.year === last.year ? String(first.year) : `${first.year}–${last.year}`,
        reference_model: first.model, reference_year_start: first.year, reference_year_end: last.year,
        range_source_urls: run.map(r => `${r.url}#page=${r.page}`), source_url: `${last.url}#page=${last.page}`,
        source_type: 'Fabricante — manuais brasileiros conferidos', source_checked_at: manuals.checked_at,
        notes: 'Faixa formada apenas por anos-modelo consecutivos conferidos no acervo oficial. Construção, índice e montagem devem ser respeitados no pneu vendido.',
        validation_scope: 'manufacturer_measure', product_fitment_confirmed: false,
        year_optional: manuals.year_optional_models.includes(first.model),
      };
      entries.push({ application, status: 'verified', kind: 'original', reviewNote: 'Manuais conferidos, com páginas e hashes no arquivo de pesquisa.' });
    }
  }
  // Mantém a pesquisa anterior sem ampliar seus anos. Suprime só referências
  // cujo modelo/posição/período já está inteiramente coberto pelos manuais novos.
  for (const application of manufacturerApplicationSeed()) {
    const seedApplication: CatalogApplication = { ...application,
      aliases: manuals.seed_aliases[application.application_id.split(':')[0] as keyof typeof manuals.seed_aliases] ?? [],
      year_optional: manuals.year_optional_seed_ids.includes(application.application_id.split(':')[0]!),
    };
    const covered = application.year_start !== null && application.year_end !== null
      && entries.some(({application: a}) => a.make === application.make
        && a.position === application.position && a.tire_size === application.tire_size
        && a.year_start! <= application.year_start! && a.year_end! >= application.year_end!
        && matchCatalogApplications([a], application.model).length > 0);
    if (!covered) entries.push({ application: seedApplication, status: 'verified', kind: 'original',
      reviewNote: 'Referência técnica já em uso. Período original preservado, sem estender pela produção da moto.' });
  }
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
       year_start,year_end,status,application_kind,reference,review_note,import_batch)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
      ON CONFLICT (environment,application_id) DO NOTHING`,
    [environment,a.application_id,a.make,a.model,a.aliases??[],a.position,a.tire_size,a.display_measure,
      a.year_start,a.year_end,status,kind,JSON.stringify(a),reviewNote,APPLICATION_BATCH]);
    inserted += result.rowCount ?? 0;
  }
  return {planned:plan.length, inserted, verified:plan.filter(r=>r.status==='verified').length,
    pending:plan.filter(r=>r.status==='pending').length, rejected:plan.filter(r=>r.status==='rejected').length};
}
