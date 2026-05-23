/**
 * Sessao 2026-05-23 — CONSOLIDAR CATALOGO + cadastrar fitments faltantes
 *
 * Descoberta durante dry-run anterior: banco tem duplicatas extensas
 * (entradas sem year + entradas com year e fitments parciais) e aliases
 * ENVENENADOS (Crosser tem "Lander" e "Tenere" como aliases, etc.).
 *
 * Esse script faz, EM ORDEM:
 *   0. INSERT 12 tire_specs novos (medidas que faltam)
 *   1. CONSOLIDAR: pra cada moto duplicada (canonica + generica/duplicata),
 *      apagar duplicata, garantir aliases corretos na canonica
 *   2. UPDATE aliases (limpar envenenamentos: Crosser != Lander != Tenere)
 *   3. INSERT variantes novas onde uma moto tem 2 geracoes de pneu diferentes
 *      (Yamaha Crosser 150 S 2025+, Yamaha Tenere 250 Flex 2020+)
 *   4. Ajustes pontuais (apagar fitment errado da Mirage 150, etc.)
 *   5. INSERT ~40 fitments amarrados as canonicas corretas
 *   6. SMOKE TESTS (resolve para queries reais do bot)
 *
 * Tudo em transacao. Dry-run default. COMMIT=1 pra aplicar.
 */
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL ausente'); process.exit(1); }
const COMMIT = process.env.COMMIT === '1';
const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ============================================================
// ETAPA 0 — tire_specs novos (igual script anterior)
// ============================================================
const NEW_TIRES: Array<{
  productCode: string; productName: string;
  tireSize: string; position: 'front' | 'rear';
  construction: 'radial' | 'bias' | null;
  widthMm: number; aspectRatio: number; rimDiameter: number;
}> = [
  { productCode: 'TIRE-90-90-14-FRONT-BIAS',  productName: 'Pneu Scooter 90/90-14 Dianteiro Diagonal',  tireSize: '90/90-14',  position: 'front', construction: 'bias', widthMm: 90,  aspectRatio: 90,  rimDiameter: 14 },
  { productCode: 'TIRE-100-90-14-REAR-BIAS',  productName: 'Pneu Scooter 100/90-14 Traseiro Diagonal',  tireSize: '100/90-14', position: 'rear',  construction: 'bias', widthMm: 100, aspectRatio: 90,  rimDiameter: 14 },
  { productCode: 'TIRE-60-100-17-FRONT-BIAS', productName: 'Pneu Moto 60/100-17 Dianteiro Diagonal',    tireSize: '60/100-17', position: 'front', construction: 'bias', widthMm: 60,  aspectRatio: 100, rimDiameter: 17 },
  { productCode: 'TIRE-110-90-17-REAR-BIAS',  productName: 'Pneu Moto 110/90-17 Traseiro Diagonal',     tireSize: '110/90-17', position: 'rear',  construction: 'bias', widthMm: 110, aspectRatio: 90,  rimDiameter: 17 },
  { productCode: 'TIRE-120-80-18-REAR-BIAS',  productName: 'Pneu Moto 120/80-18 Traseiro Diagonal',     tireSize: '120/80-18', position: 'rear',  construction: 'bias', widthMm: 120, aspectRatio: 80,  rimDiameter: 18 },
  { productCode: 'TIRE-130-70-16-REAR-BIAS',  productName: 'Pneu Scooter 130/70-16 Traseiro Diagonal',  tireSize: '130/70-16', position: 'rear',  construction: 'bias', widthMm: 130, aspectRatio: 70,  rimDiameter: 16 },
  { productCode: 'TIRE-110-80-18-REAR-BIAS',  productName: 'Pneu Moto 110/80-18 Traseiro Diagonal',     tireSize: '110/80-18', position: 'rear',  construction: 'bias', widthMm: 110, aspectRatio: 80,  rimDiameter: 18 },
  { productCode: 'TIRE-130-80-18-REAR-BIAS',  productName: 'Pneu Moto 130/80-18 Traseiro Diagonal',     tireSize: '130/80-18', position: 'rear',  construction: 'bias', widthMm: 130, aspectRatio: 80,  rimDiameter: 18 },
  { productCode: 'TIRE-130-90-16-FRONT-BIAS', productName: 'Pneu Moto 130/90-16 Dianteiro Diagonal',    tireSize: '130/90-16', position: 'front', construction: 'bias', widthMm: 130, aspectRatio: 90,  rimDiameter: 16 },
  { productCode: 'TIRE-80-90-18-FRONT-BIAS',  productName: 'Pneu Moto 80/90-18 Dianteiro Diagonal',     tireSize: '80/90-18',  position: 'front', construction: 'bias', widthMm: 80,  aspectRatio: 90,  rimDiameter: 18 },
  { productCode: 'TIRE-90-90-16-REAR-BIAS',   productName: 'Pneu Moto 90/90-16 Traseiro Diagonal',      tireSize: '90/90-16',  position: 'rear',  construction: 'bias', widthMm: 90,  aspectRatio: 90,  rimDiameter: 16 },
  { productCode: 'TIRE-110-90-16-FRONT-BIAS', productName: 'Pneu Moto 110/90-16 Dianteiro Diagonal',    tireSize: '110/90-16', position: 'front', construction: 'bias', widthMm: 110, aspectRatio: 90,  rimDiameter: 16 },
  // novos pra motos modernas (CB 300F Twister + Fazer 150 alt)
  { productCode: 'TIRE-150-60-17-REAR-RAD',   productName: 'Pneu Moto 150/60R17 Traseiro Radial',       tireSize: '150/60R17', position: 'rear',  construction: 'radial', widthMm: 150, aspectRatio: 60, rimDiameter: 17 },
  { productCode: 'TIRE-100-80-18-REAR-BIAS',  productName: 'Pneu Moto 100/80-18 Traseiro Diagonal',     tireSize: '100/80-18', position: 'rear',  construction: 'bias',   widthMm: 100, aspectRatio: 80, rimDiameter: 18 },
];

// ============================================================
// ETAPA 1 — CONSOLIDACOES: (canonica_id, duplicata_id, label, aliasesFinais)
// Por cada duplicada deletada, registramos os aliases definitivos da canonica
// ============================================================
const CONSOLIDATIONS: Array<{
  canonicalId: string;
  duplicateId: string;
  label: string;
  finalAliases: string[];  // aliases corretos pra canonica (sem envenenamento)
  newModel?: string;       // opcional: renomear canonica
}> = [
  // ---- Yamaha ----
  { canonicalId: 'ccf1347e-4b85-40e0-aac4-fa37e3478e57', duplicateId: '7b285756-0794-4ca1-8de3-3f8f56052973',
    label: 'Yamaha Crosser (canonica=XTZ 150 Crosser)',
    finalAliases: ['Crosser', 'crosser', 'Crosser 150', 'XTZ 150 Crosser', 'XTZ Crosser', 'Yamaha Crosser', 'Crosser 150 ED', 'Crosser 150 S'] },
  { canonicalId: '91ed723a-65a6-440f-a9b7-7fcb86e1ca95', duplicateId: '15484c75-13be-432d-9056-96badb09325e',
    label: 'Yamaha Lander (canonica=XTZ 250 Lander)',
    finalAliases: ['Lander', 'lander', 'Lander 250', 'XTZ 250 Lander', 'XTZ Lander', 'Yamaha Lander'] },
  { canonicalId: '62f57e29-75f6-44cc-bc54-dab36e3fb315', duplicateId: '7988f277-93b9-48c6-9afe-6ea9b45cebba',
    label: 'Yamaha Ténéré 250 (canonica=XTZ 250 Ténéré)',
    finalAliases: ['Tenere', 'tenere', 'Tenere 250', 'Ténéré', 'Ténéré 250', 'ténéré', 'XTZ 250 Tenere', 'XTZ 250 Ténéré', 'Yamaha Tenere 250'] },
  // Yamaha Ténéré (sem 250, cc null) tambem duplicada — apagar
  { canonicalId: '62f57e29-75f6-44cc-bc54-dab36e3fb315', duplicateId: 'dfae0bf4-9ae7-4084-9009-9cdb091c45a5',
    label: 'Yamaha Ténéré (sem 250, sem cc — duplicata)',
    finalAliases: ['Tenere', 'tenere', 'Tenere 250', 'Ténéré', 'Ténéré 250', 'ténéré', 'XTZ 250 Tenere', 'XTZ 250 Ténéré', 'Yamaha Tenere 250'] },
  { canonicalId: '194878be-2b02-4403-a0b3-6c122d024677', duplicateId: 'd52df1aa-3d5d-4eb0-9f25-8d3904c80197',
    label: 'Yamaha Fluo (canonica=Fluo 125 ABS)',
    finalAliases: ['Fluo', 'fluo', 'Fluo 125', 'Fluo 125 ABS', 'Yamaha Fluo'] },
  // ---- Suzuki ----
  { canonicalId: 'd8eef2f3-6023-4b0d-a8de-e3c64bb595f7', duplicateId: '8e60d136-5d1f-4ad8-b604-6220b1f66812',
    label: 'Suzuki Burgman (canonica=Burgman 125i)',
    finalAliases: ['Burgman', 'burgman', 'Burgman 125', 'Burgman 125i', 'Burgman i', 'Suzuki Burgman', 'Suzuki Burgman 125'] },
  { canonicalId: 'd7b085b5-9dca-4ec0-bb83-7f865c4e6f79', duplicateId: '1fa6633c-fe7c-4922-a04a-780884824640',
    label: 'Suzuki Boulevard C50',
    finalAliases: ['Boulevard C50', 'C50', 'Boulevard 800', 'VL800', 'Suzuki Boulevard C50', 'Boulevard'] },
  // ---- Dafra ----
  { canonicalId: '3ed37fa6-713e-4303-88ec-0e6d326d9112', duplicateId: 'e31f472d-dde8-4f36-9acd-629cbf74c26b',
    label: 'Dafra Citycom (canonica=Citycom 300i)',
    finalAliases: ['Citycom', 'citycom', 'Citycom 300', 'Citycom 300i', 'Dafra Citycom', 'Citycom S 300'] },
  { canonicalId: '1dcd8c76-0daf-48f0-9fd5-a17cc587d149', duplicateId: 'bf58b5cd-0516-4415-a2b5-55cb57834e09',
    label: 'Dafra Smart (canonica=Smart 125)',
    finalAliases: ['Smart', 'smart', 'Smart 125', 'Dafra Smart'] },
  // ---- Haojue ----
  { canonicalId: '6b6b1d89-1828-4186-a4b0-10f580408541', duplicateId: '17b1a6ed-7395-4f9b-b46e-7abdabf05ee2',
    label: 'Haojue Lindy (canonica=Lindy 125)',
    finalAliases: ['Lindy', 'lindy', 'Lindy 125', 'Haojue Lindy'] },
  // ---- Royal Enfield ----
  { canonicalId: '7eabe2fc-934f-4544-9819-0e9a2491f739', duplicateId: '41c26a0d-23d4-4cf9-b53f-38b1825c645f',
    label: 'Royal Enfield Classic (canonica=Classic 350)',
    finalAliases: ['Classic', 'classic', 'Classic 350', 'RE Classic', 'Royal Enfield Classic'] },
  { canonicalId: 'e8858328-79c9-451e-ac16-46488231fa62', duplicateId: '55b10df0-0590-4dad-b7dc-ea40b185e519',
    label: 'Royal Enfield Meteor (canonica=Meteor 350)',
    finalAliases: ['Meteor', 'meteor', 'Meteor 350', 'RE Meteor', 'Royal Enfield Meteor'] },
  { canonicalId: 'e4f9c11c-cd7c-407d-a256-ce396800c434', duplicateId: '0e0fe9e8-50ad-43a8-a37e-1c62d44c5d58',
    label: 'Royal Enfield Himalayan (canonica=Himalayan 411)',
    finalAliases: ['Himalayan', 'Himalayan 411', 'RE Himalayan', 'Royal Enfield Himalayan'] },
  { canonicalId: '09cfa8e4-77ee-4ac9-8e1a-d294000f0582', duplicateId: '624e8127-69b0-4830-8563-bd101e52711d',
    label: 'Royal Enfield Scram (canonica=Scram 411)',
    finalAliases: ['Scram', 'Scram 411', 'RE Scram', 'Royal Enfield Scram'] },
  // ---- Kasinski ----
  { canonicalId: 'fda0d389-5d57-42a6-8371-ed3fd7d60785', duplicateId: 'e636f720-dba0-4961-b1d4-4ade9b1bcd3e',
    label: 'Kasinski Mirage 150',
    finalAliases: ['Mirage 150', 'mirage 150', 'Kasinski Mirage 150', 'Mirage'] },
  { canonicalId: 'caf2866a-f089-40fc-9c76-4049bb647693', duplicateId: 'eb794560-8e5e-4e52-a892-946703adefcd',
    label: 'Kasinski Mirage 250',
    finalAliases: ['Mirage 250', 'mirage 250', 'Kasinski Mirage 250'] },
];

// ============================================================
// ETAPA 1B — Genericas Honda + Yamaha XMAX 250 sem variant (orfas, sem canonica que precise consolidar antes)
// ============================================================
const ORPHAN_DELETES: Array<{
  motoQuery: { make: string; model: string; variantIsNull?: boolean; yearIsNull?: boolean };
  label: string;
}> = [
  { motoQuery: { make: 'Honda',  model: 'PCX',   variantIsNull: true, yearIsNull: true }, label: 'Honda PCX (generica)' },
  { motoQuery: { make: 'Honda',  model: 'Bros',  variantIsNull: true, yearIsNull: true }, label: 'Honda Bros (generica)' },
  { motoQuery: { make: 'Honda',  model: 'Pop',   variantIsNull: true, yearIsNull: true }, label: 'Honda Pop (generica)' },
  { motoQuery: { make: 'Honda',  model: 'Lead',  variantIsNull: true, yearIsNull: true }, label: 'Honda Lead (generica)' },
  { motoQuery: { make: 'Honda',  model: 'Biz',   variantIsNull: true, yearIsNull: true }, label: 'Honda Biz (generica)' },
  { motoQuery: { make: 'Honda',  model: 'Elite', variantIsNull: true, yearIsNull: true }, label: 'Honda Elite (generica)' },
  { motoQuery: { make: 'Honda',  model: 'XRE',   variantIsNull: true, yearIsNull: true }, label: 'Honda XRE (generica)' },
  { motoQuery: { make: 'Yamaha', model: 'XMAX 250', variantIsNull: true, yearIsNull: true }, label: 'Yamaha XMAX 250 (sem variant)' },
];

// ============================================================
// ETAPA 2 — UPDATE de aliases adicionais em canonicas NAO duplicadas
// (motos que NAO tem duplicata mas precisam alias corretos / limpos)
// ============================================================
const ALIAS_UPDATES: Array<{
  motoQuery: { make: string; model: string; variant?: string | null; yearStart?: number | null };
  aliases: string[];
  newModel?: string;
  label: string;
}> = [
  // Honda
  { motoQuery: { make: 'Honda', model: 'PCX 150' },              aliases: ['PCX 150', 'pcx 150', 'PCX', 'pcx', 'Honda PCX 150', 'Honda PCX'], label: 'Honda PCX 150 (aliases)' },
  { motoQuery: { make: 'Honda', model: 'PCX 160' },              aliases: ['PCX 160', 'pcx 160', 'PCX', 'pcx', 'Honda PCX 160', 'Honda PCX'], label: 'Honda PCX 160 (aliases)' },
  { motoQuery: { make: 'Honda', model: 'Biz 125' },              aliases: ['Biz 125', 'biz 125', 'Biz', 'biz', 'Honda Biz', 'Honda Biz 125', 'Biz 110'], label: 'Honda Biz 125 (aliases)' },
  { motoQuery: { make: 'Honda', model: 'NXR 150 Bros' },         aliases: ['NXR 150 Bros', 'Bros 150', 'NXR Bros 150', 'Honda Bros 150', 'NXR 150', 'Bros 2005-2015'], label: 'Honda NXR 150 Bros (aliases)' },
  { motoQuery: { make: 'Honda', model: 'NXR 160 Bros' },         aliases: ['NXR 160 Bros', 'Bros 160', 'NXR Bros 160', 'Honda Bros 160', 'NXR 160', 'Bros', 'bros', 'Honda Bros'], label: 'Honda NXR 160 Bros (aliases)' },
  { motoQuery: { make: 'Honda', model: 'Pop 110i', variant: 'ES' }, aliases: ['Pop 110i', 'pop 110i', 'Pop 110', 'Pop', 'pop', 'Honda Pop', 'Pop ES', 'Pop 110i ES'], label: 'Honda Pop 110i ES (aliases)' },
  { motoQuery: { make: 'Honda', model: 'XRE 190' },              aliases: ['XRE 190', 'xre 190', 'Honda XRE 190'], label: 'Honda XRE 190 (aliases)' },
  { motoQuery: { make: 'Honda', model: 'XRE 300' },              aliases: ['XRE 300', 'xre 300', 'XRE', 'xre', 'Honda XRE', 'Honda XRE 300', 'XRE 300 Sahara'], label: 'Honda XRE 300 (aliases)' },
  { motoQuery: { make: 'Honda', model: 'Lead 110' },             aliases: ['Lead 110', 'lead 110', 'Lead', 'lead', 'Honda Lead'], label: 'Honda Lead 110 (aliases)' },
  { motoQuery: { make: 'Honda', model: 'Elite 125' },            aliases: ['Elite 125', 'elite 125', 'Elite', 'elite', 'Honda Elite'], label: 'Honda Elite 125 (aliases)' },
  // Yamaha
  { motoQuery: { make: 'Yamaha', model: 'XMAX 250', variant: 'ABS' }, aliases: ['XMAX 250', 'XMAX', 'xmax', 'XMAX 250 ABS', 'Yamaha XMAX', 'Yamaha XMAX 250'], label: 'Yamaha XMAX 250 ABS (aliases)' },
  // Yamaha Ténéré 700: TIRAR "Tenere"/"Ténéré" comum (deixar so 700)
  { motoQuery: { make: 'Yamaha', model: 'Ténéré 700' }, aliases: ['Ténéré 700', 'Tenere 700', 'tenere 700', 'Yamaha Ténéré 700', 'XTZ 700'], label: 'Yamaha Ténéré 700 (limpar aliases envenenados)' },
  // Suzuki Boulevard M800
  { motoQuery: { make: 'Suzuki', model: 'Boulevard M800', yearStart: 2005 }, aliases: ['Boulevard M800', 'M800', 'Suzuki Boulevard M800', 'VZ800', 'Intruder M800', 'Boulevard 800 M'], label: 'Suzuki Boulevard M800 (aliases)' },
  // Haojue NK150
  { motoQuery: { make: 'Haojue', model: 'NK150' }, aliases: ['NK150', 'NK 150', 'nk 150', 'Haojue NK150', 'Haojue NK 150'], label: 'Haojue NK150 (aliases + year)' },
];

// ============================================================
// ETAPA 3 — INSERT variantes novas (motos com 2 geracoes diferentes)
// ============================================================
const NEW_VARIANTS: Array<{
  make: string; model: string; variant: string | null;
  yearStart: number; yearEnd: number; cc: number; aliases: string[];
}> = [
  // Crosser nova: aro 19 + aro 17, separada da antiga
  { make: 'Yamaha', model: 'XTZ 150 Crosser', variant: 'S 2025', yearStart: 2025, yearEnd: 2026, cc: 149,
    aliases: ['Crosser 150 S', 'Crosser nova', 'Crosser 2025', 'Crosser 2026', 'Yamaha Crosser S'] },
  // Ténéré 250 Flex (atualizou medidas em 2020)
  { make: 'Yamaha', model: 'XTZ 250 Ténéré', variant: 'Flex', yearStart: 2020, yearEnd: 2026, cc: 249,
    aliases: ['Tenere', 'tenere', 'Ténéré', 'ténéré', 'Tenere 250', 'Ténéré 250', 'Tenere 250 Flex', 'Ténéré 250 Flex', 'Tenere Flex', 'Tenere 2020', 'Tenere 2021', 'Yamaha Tenere 250'] },
  // ---- 5 motos populares modernas (faltavam no banco) ----
  // 1. Honda CB 250F Twister moderna (2016-2022) — Twister 250 nova
  { make: 'Honda', model: 'CB 250F Twister', variant: null, yearStart: 2016, yearEnd: 2022, cc: 249,
    aliases: ['CB 250F Twister', 'CB Twister 250', 'Twister 250 moderna', 'CB 250F', 'Twister moderna', 'Honda CB 250F Twister', 'Twister', 'twister'] },
  // 2. Honda CB 300F Twister (2024-2026) — sucessora da CB 250F
  { make: 'Honda', model: 'CB 300F Twister', variant: null, yearStart: 2024, yearEnd: 2026, cc: 293,
    aliases: ['CB 300F Twister', 'CB 300F', 'CB Twister 300', 'Twister 300', 'Honda CB 300F'] },
  // 3. Honda CBR 250R (2011-2014) — esportiva entrada
  { make: 'Honda', model: 'CBR 250R', variant: null, yearStart: 2011, yearEnd: 2014, cc: 249,
    aliases: ['CBR 250R', 'CBR 250', 'CBR250R', 'CBR250', 'Honda CBR 250R'] },
  // 4. Yamaha XJ6 (2010-2017) — naked media
  { make: 'Yamaha', model: 'XJ6', variant: null, yearStart: 2010, yearEnd: 2017, cc: 600,
    aliases: ['XJ6', 'xj6', 'XJ6 N', 'XJ6 F', 'Yamaha XJ6'] },
  // 5. Honda CB 750 Hornet (2024-2026) — Hornet nova grande
  { make: 'Honda', model: 'CB 750 Hornet', variant: null, yearStart: 2024, yearEnd: 2026, cc: 755,
    aliases: ['CB 750 Hornet', 'Hornet 750', 'CB 750', 'CB750', 'CB750 Hornet', 'Honda Hornet 750', 'Honda CB 750'] },
];

// ============================================================
// ETAPA 4 — Ajustes pontuais (UPDATE direto)
// ============================================================
const PONTUAL_OPS: Array<{ description: string; sql: string; params: unknown[] }> = [
  // 4.1 — Crosser canonica vai ate 2024 (variante S cobre 2025+)
  { description: 'Yamaha XTZ 150 Crosser canonica: year_end 2026 → 2024',
    sql: `UPDATE commerce.vehicle_models SET year_end=2024, updated_at=NOW() WHERE id=$1 AND year_start=2015;`,
    params: ['ccf1347e-4b85-40e0-aac4-fa37e3478e57'] },
  // 4.2 — Ténéré canonica vai ate 2019 (Flex 2020+ cobre o resto)
  { description: 'Yamaha XTZ 250 Ténéré canonica: year_end 2019 → 2019 (manter)',
    sql: `UPDATE commerce.vehicle_models SET year_end=2019, updated_at=NOW() WHERE id=$1;`,
    params: ['62f57e29-75f6-44cc-bc54-dab36e3fb315'] },
  // 4.3 — Mirage 150 canonica: APAGAR fitment 130/90-15 (errado, traseiro de moto street pequena nao usa essa medida)
  { description: 'Kasinski Mirage 150: DELETE fitment errado 130/90-15',
    sql: `DELETE FROM commerce.vehicle_fitments
          WHERE vehicle_model_id='fda0d389-5d57-42a6-8371-ed3fd7d60785'
            AND tire_spec_id=(SELECT id FROM commerce.tire_specs WHERE environment='prod' AND tire_size='130/90-15' AND position='rear' LIMIT 1);`,
    params: [] },
  // 4.3b — Crosser canonica: APAGAR 90/90-19/front (era da geracao 2025, vai pra variante S 2025)
  { description: 'Yamaha XTZ 150 Crosser canonica: DELETE fitment 90/90-19/front (move pra S 2025)',
    sql: `DELETE FROM commerce.vehicle_fitments
          WHERE vehicle_model_id='ccf1347e-4b85-40e0-aac4-fa37e3478e57'
            AND tire_spec_id=(SELECT id FROM commerce.tire_specs WHERE environment='prod' AND tire_size='90/90-19' AND position='front' LIMIT 1);`,
    params: [] },
  // 4.4 — Haojue NK150: year + cc + variant (variant ajuda a desempatar do CG 150 no resolver)
  { description: 'Haojue NK150: year 2022-2026, cc 150, variant=ABS',
    sql: `UPDATE commerce.vehicle_models SET year_start=2022, year_end=2026, displacement_cc=150, variant='ABS', updated_at=NOW() WHERE id=$1;`,
    params: ['fdd64e19-da20-452e-89e2-99ef047f2ac8'] },
];

// ============================================================
// ETAPA 5 — INSERT fitments (todos amarrados na canonica certa)
// ============================================================
type FitmentRow = {
  motoQuery: { make: string; model: string; variant?: string | null; yearStart?: number | null };
  tireSize: string; position: 'front' | 'rear';
  isOem: boolean; confidence: number; source: 'manufacturer' | 'manual';
  note?: string;
};

const NEW_FITMENTS: FitmentRow[] = [
  // ---- Honda PCX 150 (canonica 2013-2022): OEM + alternativa ----
  { motoQuery: { make: 'Honda', model: 'PCX 150' }, tireSize: '100/80-14', position: 'front', isOem: true,  confidence: 0.95, source: 'manufacturer', note: 'OEM original Honda PCX 150 (2018+)' },
  { motoQuery: { make: 'Honda', model: 'PCX 150' }, tireSize: '120/70-14', position: 'rear',  isOem: true,  confidence: 0.95, source: 'manufacturer', note: 'OEM original' },
  { motoQuery: { make: 'Honda', model: 'PCX 150' }, tireSize: '90/90-14',  position: 'front', isOem: false, confidence: 0.85, source: 'manual',       note: 'alternativa comum em mercado usado' },
  { motoQuery: { make: 'Honda', model: 'PCX 150' }, tireSize: '100/90-14', position: 'rear',  isOem: false, confidence: 0.85, source: 'manual',       note: 'alternativa comum em mercado usado' },
  // ---- Honda Biz 125: falta front ----
  { motoQuery: { make: 'Honda', model: 'Biz 125' }, tireSize: '60/100-17', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Honda NXR 150 Bros: falta rear ----
  { motoQuery: { make: 'Honda', model: 'NXR 150 Bros' }, tireSize: '110/90-17', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Honda NXR 160 Bros: falta rear ----
  { motoQuery: { make: 'Honda', model: 'NXR 160 Bros' }, tireSize: '110/90-17', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Honda Pop 110i ES: falta front ----
  { motoQuery: { make: 'Honda', model: 'Pop 110i', variant: 'ES' }, tireSize: '60/100-17', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Honda XRE 190: falta rear ----
  { motoQuery: { make: 'Honda', model: 'XRE 190' }, tireSize: '110/90-17', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Honda XRE 300: falta rear ----
  { motoQuery: { make: 'Honda', model: 'XRE 300' }, tireSize: '120/80-18', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Yamaha XMAX 250 ABS: falta rear ----
  { motoQuery: { make: 'Yamaha', model: 'XMAX 250', variant: 'ABS' }, tireSize: '140/70-14', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Yamaha XTZ 150 Crosser canonica (geracao antiga 2015-2024): tem 90/90-19 que era da geracao nova — sera APAGADA em PONTUAL_OPS ----
  { motoQuery: { make: 'Yamaha', model: 'XTZ 150 Crosser', variant: null, yearStart: 2015 }, tireSize: '80/90-21',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'OEM Metzeler geracao 2014-2024' },
  { motoQuery: { make: 'Yamaha', model: 'XTZ 150 Crosser', variant: null, yearStart: 2015 }, tireSize: '110/80-18', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Yamaha XTZ 150 Crosser S 2025 (nova variante): 90/90-19 + 110/90-17 ----
  { motoQuery: { make: 'Yamaha', model: 'XTZ 150 Crosser', variant: 'S 2025' }, tireSize: '90/90-19',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Levorin OEM 2025+' },
  { motoQuery: { make: 'Yamaha', model: 'XTZ 150 Crosser', variant: 'S 2025' }, tireSize: '110/90-17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Yamaha XTZ 250 Lander: falta rear ----
  { motoQuery: { make: 'Yamaha', model: 'XTZ 250 Lander' }, tireSize: '120/80-18', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Metzeler Tourance OEM' },
  // ---- Yamaha XTZ 250 Ténéré canonica (2011-2019): falta rear ----
  { motoQuery: { make: 'Yamaha', model: 'XTZ 250 Ténéré', yearStart: 2011 }, tireSize: '120/80-18', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Metzeler Tourance OEM geracao 2011-2019' },
  // ---- Yamaha XTZ 250 Ténéré Flex (2020-2026): novas medidas ----
  { motoQuery: { make: 'Yamaha', model: 'XTZ 250 Ténéré', variant: 'Flex' }, tireSize: '90/90-21',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Flex 2020+' },
  { motoQuery: { make: 'Yamaha', model: 'XTZ 250 Ténéré', variant: 'Flex' }, tireSize: '130/80-18', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Flex 2020+' },
  // ---- Suzuki Burgman 125i: ja tem completo, nada a fazer ----
  // ---- Suzuki Boulevard C50: falta front ----
  { motoQuery: { make: 'Suzuki', model: 'Boulevard C50', yearStart: 2005 }, tireSize: '130/90-16', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Suzuki Boulevard M800 (2005-2019): vazia ----
  { motoQuery: { make: 'Suzuki', model: 'Boulevard M800', yearStart: 2005 }, tireSize: '130/90-16', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer' },
  { motoQuery: { make: 'Suzuki', model: 'Boulevard M800', yearStart: 2005 }, tireSize: '170/80-15', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Dafra Citycom 300i: ja tem 110/70-16/front + 140/70-16/rear. Adicionar 130/70-16/rear como OEM alternativo ----
  { motoQuery: { make: 'Dafra', model: 'Citycom 300i' }, tireSize: '130/70-16', position: 'rear', isOem: true, confidence: 0.90, source: 'manufacturer', note: 'medida traseira OEM Dafra Citycom 300i (140/70-16 ja cadastrado tambem)' },
  // ---- Dafra Smart 125: ja completo ----
  // ---- Haojue NK150 (vazia): completar ----
  { motoQuery: { make: 'Haojue', model: 'NK150' }, tireSize: '90/90-19',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'MT60 OEM' },
  { motoQuery: { make: 'Haojue', model: 'NK150' }, tireSize: '110/90-17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Haojue Lindy 125: ja completo ----
  // ---- Royal Enfield Classic 350 (so tem front): falta rear ----
  { motoQuery: { make: 'Royal Enfield', model: 'Classic 350' }, tireSize: '120/80-18', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'CEAT Zoom OEM' },
  // ---- Royal Enfield Meteor 350 (so tem front): falta rear ----
  { motoQuery: { make: 'Royal Enfield', model: 'Meteor 350' }, tireSize: '140/70-17', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'CEAT Zoom Plus OEM' },
  // ---- Kasinski Mirage 150 (apos apagar fitment errado 130/90-15): cadastrar corretos ----
  { motoQuery: { make: 'Kasinski', model: 'Mirage 150', yearStart: 2010 }, tireSize: '80/90-18', position: 'front', isOem: true, confidence: 0.85, source: 'manual', note: 'convertido de 2.75-18 (notacao antiga)' },
  { motoQuery: { make: 'Kasinski', model: 'Mirage 150', yearStart: 2010 }, tireSize: '90/90-16', position: 'rear',  isOem: true, confidence: 0.85, source: 'manual', note: 'convertido de 3.50-16 (notacao antiga)' },
  // ---- Kasinski Mirage 250 (canonica 2001-2013, vazia): cadastrar ----
  { motoQuery: { make: 'Kasinski', model: 'Mirage 250', yearStart: 2001 }, tireSize: '110/90-16', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Metzeler ME 77' },
  { motoQuery: { make: 'Kasinski', model: 'Mirage 250', yearStart: 2001 }, tireSize: '140/90-15', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Honda CB 250F Twister moderna (2016-2022): completo ----
  { motoQuery: { make: 'Honda', model: 'CB 250F Twister' }, tireSize: '110/70-17', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Pirelli Diablo Rosso II OEM' },
  { motoQuery: { make: 'Honda', model: 'CB 250F Twister' }, tireSize: '140/70-17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Honda CB 300F Twister (2024-2026): completo (rear novo 150/60R17) ----
  { motoQuery: { make: 'Honda', model: 'CB 300F Twister' }, tireSize: '110/70-17', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Pirelli Diablo Rosso III OEM' },
  { motoQuery: { make: 'Honda', model: 'CB 300F Twister' }, tireSize: '150/60R17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Honda CBR 250R (2011-2014): completo ----
  { motoQuery: { make: 'Honda', model: 'CBR 250R' }, tireSize: '110/70-17', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Pirelli OEM' },
  { motoQuery: { make: 'Honda', model: 'CBR 250R' }, tireSize: '140/70-17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Yamaha XJ6 (2010-2017): completo ----
  { motoQuery: { make: 'Yamaha', model: 'XJ6' }, tireSize: '120/70R17', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'naked media — radial OEM' },
  { motoQuery: { make: 'Yamaha', model: 'XJ6' }, tireSize: '160/60R17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Honda CB 750 Hornet (2024-2026): completo ----
  { motoQuery: { make: 'Honda', model: 'CB 750 Hornet' }, tireSize: '120/70R17', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Michelin Road 5 OEM' },
  { motoQuery: { make: 'Honda', model: 'CB 750 Hornet' }, tireSize: '160/60R17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
  // ---- Correcao: Honda XR 250 Tornado (2001-2008): falta rear ----
  { motoQuery: { make: 'Honda', model: 'XR 250 Tornado' }, tireSize: '120/80-18', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'OEM trail Honda Tornado' },
  // ---- Yamaha Fazer 150: adicionar 100/80-18 rear como alternativa (manual Yamaha YS 150 Fazer) ----
  { motoQuery: { make: 'Yamaha', model: 'Fazer 150' }, tireSize: '100/80-18', position: 'rear', isOem: false, confidence: 0.85, source: 'manual', note: 'medida alternativa OEM Yamaha FZ15 (90/90-18 ja cadastrado tambem)' },
];

// ----------------- HELPERS -----------------

async function resolveMotoId(query: FitmentRow['motoQuery'] | ALIAS_UPDATES[number]['motoQuery']): Promise<string | null> {
  const params: unknown[] = [query.make, query.model];
  let where = "make=$1 AND model=$2 AND deleted_at IS NULL AND environment='prod'";
  if (query.variant !== undefined) {
    params.push(query.variant);
    where += ` AND variant IS NOT DISTINCT FROM $${params.length}`;
  }
  if (query.yearStart !== undefined) {
    params.push(query.yearStart);
    where += ` AND year_start IS NOT DISTINCT FROM $${params.length}`;
  }
  // ORDER BY pra deterministico: prefere com year_start preenchido (canonica > nova variante apos delete)
  const res = await client.query(
    `SELECT id FROM commerce.vehicle_models WHERE ${where}
     ORDER BY year_start NULLS LAST, variant NULLS FIRST LIMIT 1;`,
    params,
  );
  return res.rows[0]?.id ?? null;
}

async function resolveOrphanId(query: ORPHAN_DELETES[number]['motoQuery']): Promise<string | null> {
  const params: unknown[] = [query.make, query.model];
  let where = "make=$1 AND model=$2 AND deleted_at IS NULL AND environment='prod'";
  if (query.variantIsNull) where += ' AND variant IS NULL';
  if (query.yearIsNull) where += ' AND year_start IS NULL AND year_end IS NULL';
  const res = await client.query(`SELECT id FROM commerce.vehicle_models WHERE ${where} LIMIT 1;`, params);
  return res.rows[0]?.id ?? null;
}

async function safeDelete(id: string, label: string): Promise<boolean> {
  const refsF = await client.query(`SELECT COUNT(*)::int AS n FROM commerce.vehicle_fitments WHERE vehicle_model_id=$1;`, [id]);
  const refsD = await client.query(`SELECT COUNT(*)::int AS n FROM commerce.fitment_discoveries WHERE vehicle_model_id=$1;`, [id]);
  if (refsF.rows[0].n > 0 || refsD.rows[0].n > 0) {
    console.log(`  ! ${label}: TEM REFS (fitments=${refsF.rows[0].n}, discoveries=${refsD.rows[0].n}) — NAO APAGUEI`);
    return false;
  }
  await client.query(`DELETE FROM commerce.vehicle_models WHERE id=$1;`, [id]);
  console.log(`  - DELETE ${label} (id=${id.slice(0,8)})`);
  return true;
}

// ----------------- MAIN -----------------

async function main() {
  await client.connect();
  await client.query('BEGIN');
  console.log(`=== CONSOLIDAR CATALOGO 2026-05-23 (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  try {
    // ETAPA 0 — tire_specs novos
    console.log('ETAPA 0 — tire_specs novos');
    const tireSpecIdBySize = new Map<string, string>();
    const existing = await client.query(`SELECT id, tire_size, "position" FROM commerce.tire_specs WHERE environment='prod';`);
    for (const row of existing.rows) tireSpecIdBySize.set(`${row.tire_size}|${row.position}`, row.id);
    let createdTires = 0;
    for (const t of NEW_TIRES) {
      const key = `${t.tireSize}|${t.position}`;
      if (tireSpecIdBySize.has(key)) { console.log(`  ${t.tireSize} ${t.position}: ja existe`); continue; }
      const prodRes = await client.query(
        `INSERT INTO commerce.products (environment, product_code, product_name, product_type) VALUES ('prod', $1, $2, 'tire') RETURNING id;`,
        [t.productCode, t.productName]);
      const productId = prodRes.rows[0].id;
      const tsRes = await client.query(
        `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter, construction, "position")
         VALUES ('prod', $1, $2, $3, $4, $5, $6, $7) RETURNING id;`,
        [productId, t.tireSize, t.widthMm, t.aspectRatio, t.rimDiameter, t.construction, t.position]);
      tireSpecIdBySize.set(key, tsRes.rows[0].id);
      await client.query(
        `INSERT INTO commerce.product_prices (environment, product_id, price_amount, currency, price_type, valid_from)
         VALUES ('prod', $1, 99.00, 'BRL', 'regular', NOW());`, [productId]);
      await client.query(
        `INSERT INTO commerce.stock_levels (environment, product_id, quantity_available, quantity_reserved, location, last_adjusted_at)
         VALUES ('prod', $1, 10, 0, 'main', NOW());`, [productId]);
      createdTires += 1;
      console.log(`  + ${t.tireSize} ${t.position}`);
    }
    console.log(`  Total novos: ${createdTires}\n`);

    // ETAPA 1 — CONSOLIDACOES
    console.log('ETAPA 1 — CONSOLIDAR duplicatas');
    let consolidated = 0;
    for (const c of CONSOLIDATIONS) {
      // Atualiza aliases corretos na canonica
      await client.query(
        `UPDATE commerce.vehicle_models SET aliases=$2, updated_at=NOW() WHERE id=$1;`,
        [c.canonicalId, c.finalAliases]);
      if (c.newModel) {
        await client.query(`UPDATE commerce.vehicle_models SET model=$2, updated_at=NOW() WHERE id=$1;`,
          [c.canonicalId, c.newModel]);
      }
      // Tenta apagar duplicata (so se sem refs)
      const ok = await safeDelete(c.duplicateId, c.label);
      if (ok) consolidated += 1;
    }
    console.log(`  Total consolidacoes: ${consolidated}/${CONSOLIDATIONS.length}\n`);

    // ETAPA 1B — Orfas
    console.log('ETAPA 1B — Orfas genericas (Honda + XMAX)');
    let orphans = 0;
    for (const o of ORPHAN_DELETES) {
      const id = await resolveOrphanId(o.motoQuery);
      if (!id) { console.log(`  ? ${o.label}: nao encontrada (ja apagada?)`); continue; }
      const ok = await safeDelete(id, o.label);
      if (ok) orphans += 1;
    }
    console.log(`  Total orfas: ${orphans}/${ORPHAN_DELETES.length}\n`);

    // ETAPA 2 — Aliases corretos em canonicas nao-duplicadas
    console.log('ETAPA 2 — UPDATE aliases em canonicas (limpar envenenamentos)');
    for (const u of ALIAS_UPDATES) {
      const id = await resolveMotoId(u.motoQuery);
      if (!id) { console.log(`  ? ${u.label}: moto nao encontrada`); continue; }
      const params: unknown[] = [id, u.aliases];
      const sets = ['aliases=$2', 'updated_at=NOW()'];
      if (u.newModel) { params.push(u.newModel); sets.push(`model=$${params.length}`); }
      await client.query(`UPDATE commerce.vehicle_models SET ${sets.join(', ')} WHERE id=$1;`, params);
      console.log(`  ~ ${u.label}`);
    }
    console.log('');

    // ETAPA 3 — Variantes novas (Crosser S 2025, Tenere Flex 2020)
    console.log('ETAPA 3 — Variantes novas');
    for (const v of NEW_VARIANTS) {
      const exists = await client.query(
        `SELECT id FROM commerce.vehicle_models
         WHERE environment='prod' AND deleted_at IS NULL
           AND make=$1 AND model=$2 AND (variant IS NOT DISTINCT FROM $3) AND (year_start IS NOT DISTINCT FROM $4)
         LIMIT 1;`, [v.make, v.model, v.variant, v.yearStart]);
      if (exists.rows.length > 0) { console.log(`  ${v.make} ${v.model} ${v.variant}: ja existe`); continue; }
      await client.query(
        `INSERT INTO commerce.vehicle_models
           (environment, vehicle_type, make, model, variant, year_start, year_end, displacement_cc, aliases)
         VALUES ('prod', 'motorcycle', $1, $2, $3, $4, $5, $6, $7);`,
        [v.make, v.model, v.variant, v.yearStart, v.yearEnd, v.cc, v.aliases]);
      console.log(`  + ${v.make} ${v.model} ${v.variant} (${v.yearStart}-${v.yearEnd})`);
    }
    console.log('');

    // ETAPA 4 — Ajustes pontuais
    console.log('ETAPA 4 — Ajustes pontuais');
    for (const op of PONTUAL_OPS) {
      const r = await client.query(op.sql, op.params);
      console.log(`  ~ ${op.description} (rows: ${r.rowCount})`);
    }
    console.log('');

    // ETAPA 5 — Fitments
    console.log('ETAPA 5 — Fitments');
    let createdFitments = 0, skippedFitments = 0, failedFitments = 0;
    for (const f of NEW_FITMENTS) {
      const motoId = await resolveMotoId(f.motoQuery);
      if (!motoId) { console.log(`  ! ${f.motoQuery.make} ${f.motoQuery.model} ${f.motoQuery.variant ?? ''} (${f.motoQuery.yearStart ?? '-'}): moto nao encontrada`); failedFitments++; continue; }
      const tsId = tireSpecIdBySize.get(`${f.tireSize}|${f.position}`);
      if (!tsId) { console.log(`  ! ${f.tireSize}/${f.position}: tire_spec nao encontrado`); failedFitments++; continue; }
      const exists = await client.query(
        `SELECT 1 FROM commerce.vehicle_fitments
         WHERE environment='prod' AND vehicle_model_id=$1 AND tire_spec_id=$2 AND "position"=$3;`,
        [motoId, tsId, f.position]);
      if (exists.rows.length > 0) { skippedFitments++; continue; }
      await client.query(
        `INSERT INTO commerce.vehicle_fitments (environment, vehicle_model_id, tire_spec_id, "position", is_oem, source, confidence_level)
         VALUES ('prod', $1, $2, $3, $4, $5, $6);`,
        [motoId, tsId, f.position, f.isOem, f.source, f.confidence]);
      createdFitments++;
      console.log(`  + ${f.motoQuery.make} ${f.motoQuery.model} ${f.motoQuery.variant ?? ''} ← ${f.tireSize}/${f.position}${f.isOem ? ' OEM' : ' alt'}`);
    }
    console.log(`\n  Fitments: criados=${createdFitments}, pulados=${skippedFitments}, falhados=${failedFitments}\n`);

    // ETAPA 6 — SMOKE TESTS
    console.log('ETAPA 6 — SMOKE TESTS');
    const probes: Array<{ moto: string; year?: number; expect: string }> = [
      { moto: 'PCX', year: 2020,   expect: 'Honda PCX 150 (2013-2022)' },
      { moto: 'PCX', year: 2024,   expect: 'Honda PCX 160 (2023-2026)' },
      { moto: 'Crosser', year: 2018, expect: 'Yamaha XTZ 150 Crosser (2015-2024) — antiga' },
      { moto: 'Crosser', year: 2025, expect: 'Yamaha XTZ 150 Crosser S 2025 (2025-2026) — nova' },
      { moto: 'Tenere', year: 2015,  expect: 'Yamaha XTZ 250 Ténéré (2011-2019)' },
      { moto: 'Tenere', year: 2022,  expect: 'Yamaha XTZ 250 Ténéré Flex (2020-2026)' },
      { moto: 'Lander',              expect: 'Yamaha XTZ 250 Lander (2007-2026)' },
      { moto: 'Burgman',             expect: 'Suzuki Burgman 125i' },
      { moto: 'Citycom',             expect: 'Dafra Citycom 300i' },
      { moto: 'Lindy',               expect: 'Haojue Lindy 125' },
      { moto: 'Classic 350',         expect: 'Royal Enfield Classic 350 (uma so)' },
      { moto: 'Meteor',              expect: 'Royal Enfield Meteor 350' },
      { moto: 'Mirage 150',          expect: 'Kasinski Mirage 150' },
      { moto: 'Mirage 250',          expect: 'Kasinski Mirage 250' },
      { moto: 'XMAX',                expect: 'Yamaha XMAX 250 ABS' },
      { moto: 'Boulevard',           expect: 'Suzuki Boulevard C50/M800' },
      { moto: 'NK 150',              expect: 'Haojue NK150' },
      // motos modernas adicionadas nesta rodada
      { moto: 'CB 250F Twister',     expect: 'Honda CB 250F Twister (2016-2022)' },
      { moto: 'Twister', year: 2020, expect: 'Honda CB 250F Twister (Twister 250 moderna)' },
      { moto: 'CB 300F',             expect: 'Honda CB 300F Twister (2024-2026)' },
      { moto: 'CBR 250R',            expect: 'Honda CBR 250R (2011-2014)' },
      { moto: 'XJ6',                 expect: 'Yamaha XJ6 (2010-2017)' },
      { moto: 'Hornet 750',          expect: 'Honda CB 750 Hornet (2024-2026)' },
      { moto: 'Tornado',             expect: 'Honda XR 250 Tornado (agora com front + rear)' },
      { moto: 'Fazer 150',           expect: 'Yamaha Fazer 150 (agora com 90/90-18 + 100/80-18 rear)' },
    ];
    for (const p of probes) {
      const r = await client.query(
        `SELECT make, model, variant, year_start, year_end, match_type, match_similarity
         FROM commerce.resolve_vehicle_model('prod'::env_t, $1, $2, 0.4) LIMIT 3;`,
        [p.moto, p.year ?? null]);
      console.log(`  resolve('${p.moto}'${p.year ? `, ${p.year}` : ''}) [esperado: ${p.expect}]:`);
      for (const row of r.rows) {
        console.log(`    → ${row.make} ${row.model} ${row.variant ?? ''} (${row.year_start ?? '-'}-${row.year_end ?? '-'}) ${row.match_type} sim=${Number(row.match_similarity).toFixed(2)}`);
      }
    }

    // SMOKE: find_compatible_tires na PCX 150 (bug 593) — agora deve voltar 4 produtos (OEM + alt)
    const pcx = await client.query(
      `SELECT id FROM commerce.vehicle_models
       WHERE environment='prod' AND deleted_at IS NULL AND make='Honda' AND model='PCX 150' AND year_start=2013 LIMIT 1;`);
    if (pcx.rows.length > 0) {
      const compat = await client.query(
        `SELECT * FROM commerce.find_compatible_tires('prod'::env_t, $1, NULL);`, [pcx.rows[0].id]);
      console.log(`\n  find_compatible_tires(PCX 150): ${compat.rows.length} pneus`);
      for (const c of compat.rows) {
        console.log(`    ${c.tire_size} ${c.fitment_position} | preco=${c.current_price} | estoque=${c.total_stock}`);
      }
    }

    // ETAPA 7 — RELATORIO FINAL DO ESTADO DO BANCO (antes do COMMIT/ROLLBACK)
    console.log('\n========================================');
    console.log('RELATORIO FINAL — ESTADO DO BANCO');
    console.log('========================================\n');

    // 7.1 — Resumo de contagens
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM commerce.vehicle_models WHERE environment='prod' AND deleted_at IS NULL) AS motos,
        (SELECT COUNT(*) FROM commerce.products WHERE environment='prod') AS products,
        (SELECT COUNT(*) FROM commerce.tire_specs WHERE environment='prod') AS tire_specs,
        (SELECT COUNT(*) FROM commerce.vehicle_fitments WHERE environment='prod') AS fitments,
        (SELECT COUNT(*) FROM commerce.product_prices WHERE environment='prod') AS prices,
        (SELECT COUNT(*) FROM commerce.stock_levels WHERE environment='prod') AS stock;
    `);
    const c = counts.rows[0];
    console.log(`Motos: ${c.motos} | Produtos: ${c.products} | Tire_specs: ${c.tire_specs} | Fitments: ${c.fitments}`);
    console.log(`Prices: ${c.prices} | Stock_levels: ${c.stock}\n`);

    // 7.2 — Cobertura: motos com vs sem fitment, por marca
    const coverage = await client.query(`
      SELECT vm.make,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM commerce.vehicle_fitments vf WHERE vf.vehicle_model_id=vm.id)) AS com_fitment,
        COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM commerce.vehicle_fitments vf WHERE vf.vehicle_model_id=vm.id)) AS sem_fitment
      FROM commerce.vehicle_models vm
      WHERE vm.environment='prod' AND vm.deleted_at IS NULL
      GROUP BY vm.make
      ORDER BY total DESC;
    `);
    console.log('--- COBERTURA POR MARCA ---');
    console.log('Marca'.padEnd(20), 'Total'.padStart(6), 'C/Fitment'.padStart(11), 'S/Fitment'.padStart(11));
    for (const r of coverage.rows) {
      console.log(r.make.padEnd(20), String(r.total).padStart(6), String(r.com_fitment).padStart(11), String(r.sem_fitment).padStart(11));
    }
    console.log('');

    // 7.3 — Todos os tire_specs com qtd de fitments e motos que usam
    const tiresList = await client.query(`
      SELECT ts.tire_size, ts.position, p.product_name, pp.price_amount, sl.quantity_available,
        COUNT(DISTINCT vf.vehicle_model_id) AS qtd_motos,
        ARRAY_AGG(DISTINCT vm.make || ' ' || vm.model || COALESCE(' ' || vm.variant, ''))
          FILTER (WHERE vm.id IS NOT NULL) AS motos
      FROM commerce.tire_specs ts
      LEFT JOIN commerce.products p ON p.id = ts.product_id
      LEFT JOIN commerce.product_prices pp ON pp.product_id = ts.product_id AND pp.environment='prod'
      LEFT JOIN commerce.stock_levels sl ON sl.product_id = ts.product_id AND sl.environment='prod'
      LEFT JOIN commerce.vehicle_fitments vf ON vf.tire_spec_id = ts.id
      LEFT JOIN commerce.vehicle_models vm ON vm.id = vf.vehicle_model_id AND vm.deleted_at IS NULL
      WHERE ts.environment='prod'
      GROUP BY ts.id, ts.tire_size, ts.position, p.product_name, pp.price_amount, sl.quantity_available
      ORDER BY ts.position, ts.rim_diameter NULLS LAST, ts.width_mm NULLS LAST, ts.tire_size;
    `);
    console.log('--- TODOS OS PNEUS (tire_specs) ---');
    console.log('Medida'.padEnd(13), 'Pos'.padEnd(6), 'R$'.padStart(7), 'Est'.padStart(4), 'Motos'.padStart(5), 'Onde usa');
    for (const r of tiresList.rows) {
      const motosStr = r.motos ? r.motos.join('; ') : '(sem fitment)';
      const motosShown = motosStr.length > 90 ? motosStr.slice(0, 87) + '...' : motosStr;
      console.log(
        r.tire_size.padEnd(13),
        (r.position ?? '').padEnd(6),
        String(r.price_amount ?? '?').padStart(7),
        String(r.quantity_available ?? '?').padStart(4),
        String(r.qtd_motos).padStart(5),
        motosShown,
      );
    }
    console.log('');

    // 7.4 — Top motos populares com fitments completos
    const popular = await client.query(`
      SELECT vm.make, vm.model, vm.variant, vm.year_start, vm.year_end,
        ARRAY_AGG(DISTINCT ts.tire_size || '/' || vf.position) FILTER (WHERE vf.id IS NOT NULL) AS fitments
      FROM commerce.vehicle_models vm
      LEFT JOIN commerce.vehicle_fitments vf ON vf.vehicle_model_id = vm.id
      LEFT JOIN commerce.tire_specs ts ON ts.id = vf.tire_spec_id
      WHERE vm.environment='prod' AND vm.deleted_at IS NULL
        AND vm.make IN ('Honda', 'Yamaha', 'Suzuki', 'Haojue', 'Dafra', 'Kasinski', 'Royal Enfield', 'Bajaj')
      GROUP BY vm.id, vm.make, vm.model, vm.variant, vm.year_start, vm.year_end
      ORDER BY vm.make, vm.model, vm.variant NULLS FIRST, vm.year_start NULLS FIRST;
    `);
    console.log('--- MOTOS POPULARES COM SEUS PNEUS ---');
    console.log('Marca'.padEnd(15), 'Modelo'.padEnd(22), 'Variante'.padEnd(10), 'Anos'.padEnd(10), 'Pneus');
    for (const r of popular.rows) {
      const anos = r.year_start && r.year_end ? `${r.year_start}-${r.year_end}` : '(sem ano)';
      const pneus = r.fitments ? r.fitments.join(', ') : '(vazio)';
      console.log(
        r.make.padEnd(15),
        (r.model || '').padEnd(22),
        (r.variant || '').padEnd(10),
        anos.padEnd(10),
        pneus,
      );
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log('\n*** COMMIT efetuado. Catalogo consolidado em prod. ***');
    } else {
      await client.query('ROLLBACK');
      console.log('\n*** DRY-RUN: ROLLBACK efetuado. Nada gravado. Rode com COMMIT=1 pra aplicar. ***');
    }
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('\nErro — ROLLBACK efetuado:', err.message);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch(() => process.exit(1));
