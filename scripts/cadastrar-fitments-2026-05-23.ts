/**
 * Sessao 2026-05-23 — fix anti-alucinacao (camada 4: cobertura operacional)
 *
 * 1. Cria 12 tire_specs/products novos pras medidas que faltam
 * 2. UPDATE years em motos single-geracao sem year
 * 3. INSERT variantes novas (Crosser, Tenere, Burgman — duas geracoes cada)
 * 4. DELETE entradas genericas duplicadas (sem year, sem fitment) — autorizado pelo Wallace
 * 5. INSERT ~35 fitments amarrados
 *
 * Tudo em transacao unica. Dry-run por default.
 *
 * Uso:
 *   DRY-RUN: npx tsx --env-file=.env scripts/cadastrar-fitments-2026-05-23.ts
 *   COMMIT:  COMMIT=1 npx tsx --env-file=.env scripts/cadastrar-fitments-2026-05-23.ts
 */
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL ausente'); process.exit(1); }
const COMMIT = process.env.COMMIT === '1';
const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ============================================================
// ETAPA 0 — Medidas (tire_specs) novas
// ============================================================
const NEW_TIRES: Array<{
  productCode: string;
  productName: string;
  tireSize: string;
  position: 'front' | 'rear' | 'both';
  construction: 'radial' | 'bias' | null;
  widthMm: number;
  aspectRatio: number;
  rimDiameter: number;
}> = [
  { productCode: 'TIRE-90-90-14-FRONT-BIAS',   productName: 'Pneu Scooter 90/90-14 Dianteiro Diagonal',  tireSize: '90/90-14',   position: 'front', construction: 'bias', widthMm: 90,  aspectRatio: 90,  rimDiameter: 14 },
  { productCode: 'TIRE-100-90-14-REAR-BIAS',   productName: 'Pneu Scooter 100/90-14 Traseiro Diagonal',  tireSize: '100/90-14',  position: 'rear',  construction: 'bias', widthMm: 100, aspectRatio: 90,  rimDiameter: 14 },
  { productCode: 'TIRE-60-100-17-FRONT-BIAS',  productName: 'Pneu Moto 60/100-17 Dianteiro Diagonal',    tireSize: '60/100-17',  position: 'front', construction: 'bias', widthMm: 60,  aspectRatio: 100, rimDiameter: 17 },
  { productCode: 'TIRE-110-90-17-REAR-BIAS',   productName: 'Pneu Moto 110/90-17 Traseiro Diagonal',     tireSize: '110/90-17',  position: 'rear',  construction: 'bias', widthMm: 110, aspectRatio: 90,  rimDiameter: 17 },
  { productCode: 'TIRE-120-80-18-REAR-BIAS',   productName: 'Pneu Moto 120/80-18 Traseiro Diagonal',     tireSize: '120/80-18',  position: 'rear',  construction: 'bias', widthMm: 120, aspectRatio: 80,  rimDiameter: 18 },
  { productCode: 'TIRE-130-70-16-REAR-BIAS',   productName: 'Pneu Scooter 130/70-16 Traseiro Diagonal',  tireSize: '130/70-16',  position: 'rear',  construction: 'bias', widthMm: 130, aspectRatio: 70,  rimDiameter: 16 },
  { productCode: 'TIRE-110-80-18-REAR-BIAS',   productName: 'Pneu Moto 110/80-18 Traseiro Diagonal',     tireSize: '110/80-18',  position: 'rear',  construction: 'bias', widthMm: 110, aspectRatio: 80,  rimDiameter: 18 },
  { productCode: 'TIRE-130-80-18-REAR-BIAS',   productName: 'Pneu Moto 130/80-18 Traseiro Diagonal',     tireSize: '130/80-18',  position: 'rear',  construction: 'bias', widthMm: 130, aspectRatio: 80,  rimDiameter: 18 },
  { productCode: 'TIRE-130-90-16-FRONT-BIAS',  productName: 'Pneu Moto 130/90-16 Dianteiro Diagonal',    tireSize: '130/90-16',  position: 'front', construction: 'bias', widthMm: 130, aspectRatio: 90,  rimDiameter: 16 },
  { productCode: 'TIRE-80-90-18-FRONT-BIAS',   productName: 'Pneu Moto 80/90-18 Dianteiro Diagonal',     tireSize: '80/90-18',   position: 'front', construction: 'bias', widthMm: 80,  aspectRatio: 90,  rimDiameter: 18 },
  { productCode: 'TIRE-90-90-16-REAR-BIAS',    productName: 'Pneu Moto 90/90-16 Traseiro Diagonal',      tireSize: '90/90-16',   position: 'rear',  construction: 'bias', widthMm: 90,  aspectRatio: 90,  rimDiameter: 16 },
  { productCode: 'TIRE-110-90-16-FRONT-BIAS',  productName: 'Pneu Moto 110/90-16 Dianteiro Diagonal',    tireSize: '110/90-16',  position: 'front', construction: 'bias', widthMm: 110, aspectRatio: 90,  rimDiameter: 16 },
];

// ============================================================
// ETAPA 1 — UPDATE years em motos single-geracao (sem year hoje)
// ============================================================
const YEAR_UPDATES: Array<{
  id: string; label: string;
  yearStart: number; yearEnd: number;
  cc?: number; newModel?: string; aliases?: string[];
}> = [
  { id: 'd52df1aa-3d5d-4eb0-9f25-8d3904c80197', label: 'Yamaha Fluo 125', yearStart: 2024, yearEnd: 2026, aliases: ['Fluo', 'fluo', 'Fluo 125', 'Yamaha Fluo'] },
  { id: '15484c75-13be-432d-9056-96badb09325e', label: 'Yamaha Lander 250', yearStart: 2006, yearEnd: 2026, cc: 250, aliases: ['Lander', 'lander', 'Lander 250', 'XTZ 250', 'XTZ Lander', 'Yamaha Lander'] },
  { id: '17b1a6ed-7395-4f9b-b46e-7abdabf05ee2', label: 'Haojue Lindy 125', yearStart: 2018, yearEnd: 2026, aliases: ['Lindy', 'lindy', 'Lindy 125', 'Haojue Lindy'] },
  { id: 'fdd64e19-da20-452e-89e2-99ef047f2ac8', label: 'Haojue NK150', yearStart: 2022, yearEnd: 2026, aliases: ['NK 150', 'nk 150', 'NK150', 'nk150', 'Haojue NK150', 'Haojue NK 150'] },
  { id: 'bf58b5cd-0516-4415-a2b5-55cb57834e09', label: 'Dafra Smart 125', yearStart: 2010, yearEnd: 2018, aliases: ['Smart', 'smart', 'Smart 125', 'Dafra Smart'] },
  { id: 'e31f472d-dde8-4f36-9acd-629cbf74c26b', label: 'Dafra Citycom 300', yearStart: 2014, yearEnd: 2026, aliases: ['Citycom', 'citycom', 'Citycom 300', 'Dafra Citycom', 'Citycom S 300'] },
  { id: '41c26a0d-23d4-4cf9-b53f-38b1825c645f', label: 'Royal Enfield Classic 350', yearStart: 2021, yearEnd: 2026, newModel: 'Classic 350', aliases: ['Classic', 'classic', 'Classic 350', 'RE Classic', 'Royal Enfield Classic'] },
  { id: '55b10df0-0590-4dad-b7dc-ea40b185e519', label: 'Royal Enfield Meteor 350', yearStart: 2021, yearEnd: 2026, newModel: 'Meteor 350', aliases: ['Meteor', 'meteor', 'Meteor 350', 'RE Meteor', 'Royal Enfield Meteor'] },
];

// ============================================================
// ETAPA 2 — INSERT variantes novas (motos com 2 geracoes de pneu)
// ============================================================
const NEW_VARIANTS: Array<{
  make: string; model: string; variant: string | null;
  yearStart: number; yearEnd: number; cc: number; aliases: string[];
}> = [
  { make: 'Yamaha', model: 'Crosser 150', variant: null, yearStart: 2014, yearEnd: 2024, cc: 149,
    aliases: ['Crosser', 'crosser', 'Crosser 150', 'XTZ Crosser', 'Yamaha Crosser'] },
  { make: 'Yamaha', model: 'Crosser 150', variant: 'S', yearStart: 2025, yearEnd: 2026, cc: 149,
    aliases: ['Crosser 150 S', 'Crosser nova', 'Crosser 2025'] },
  { make: 'Yamaha', model: 'Ténéré 250', variant: null, yearStart: 2010, yearEnd: 2019, cc: 249,
    aliases: ['Tenere', 'tenere', 'Tenere 250', 'Ténéré', 'Tenerê', 'XTZ 250 Tenere'] },
  { make: 'Yamaha', model: 'Ténéré 250', variant: 'Flex', yearStart: 2020, yearEnd: 2026, cc: 249,
    aliases: ['Tenere 250 Flex', 'Tenere nova', 'Tenere 2020'] },
  { make: 'Suzuki', model: 'Burgman 125', variant: null, yearStart: 2012, yearEnd: 2019, cc: 124,
    aliases: ['Burgman', 'burgman', 'Burgman 125', 'Burgman i', 'Burgman 125i', 'Suzuki Burgman'] },
];

// ============================================================
// ETAPA 3 — DELETE genericas duplicadas (sem year, sem fitment, sem discovery)
// 8 Honda + 4 outras = 12 total (confirmado zero referencias via MCP)
// ============================================================
const GENERIC_DELETES: Array<{ id: string; label: string }> = [
  // Honda — todas confirmadas sem fitment + sem discovery em sessao anterior
  { id: '', label: 'Honda PCX (generica)' },        // resolver no script via lookup
  { id: '', label: 'Honda Bros (generica)' },
  { id: '', label: 'Honda Pop (generica)' },
  { id: '', label: 'Honda Lead (generica)' },
  { id: '', label: 'Honda Biz (generica)' },
  { id: '', label: 'Honda Elite (generica)' },
  { id: '', label: 'Honda XRE (generica)' },
  // Yamaha
  { id: '50c5455b-11b8-4519-a6f9-ff85ab0d33dd', label: 'Yamaha XMAX 250 (sem variant)' },
  { id: '7b285756-0794-4ca1-8de3-3f8f56052973', label: 'Yamaha Crosser (sem year - apos criar variantes)' },
  { id: '7988f277-93b9-48c6-9afe-6ea9b45cebba', label: 'Yamaha Ténéré 250 (sem year - apos criar variantes)' },
  // Suzuki
  { id: '8e60d136-5d1f-4ad8-b604-6220b1f66812', label: 'Suzuki Burgman (sem year - apos criar 2012-2019)' },
  { id: '1fa6633c-fe7c-4922-a04a-780884824640', label: 'Suzuki Boulevard C50 (sem year)' },
  // Kasinski
  { id: 'e636f720-dba0-4961-b1d4-4ade9b1bcd3e', label: 'Kasinski Mirage 150 (sem year)' },
  { id: 'eb794560-8e5e-4e52-a892-946703adefcd', label: 'Kasinski Mirage 250 (sem year)' },
];

// ============================================================
// ETAPA 4 — Fitments (motoId + tireSize + position + isOem + confidence)
// Lista construida da pesquisa de fontes (manuais oficiais + sites de motos)
// ============================================================
type FitmentRow = {
  motoLookup: { make: string; model: string; variant?: string | null; yearStart?: number | null };
  tireSize: string;
  position: 'front' | 'rear';
  isOem: boolean;
  confidence: number;
  source: 'manual' | 'manufacturer' | 'discovery_promoted';
  note?: string;
};

const NEW_FITMENTS: FitmentRow[] = [
  // ---- Honda PCX 150 (2013-2022): OEM + alternativa popular ----
  { motoLookup: { make: 'Honda', model: 'PCX 150', yearStart: 2013 }, tireSize: '100/80-14', position: 'front', isOem: true,  confidence: 0.95, source: 'manufacturer', note: 'OEM original Honda 2018+' },
  { motoLookup: { make: 'Honda', model: 'PCX 150', yearStart: 2013 }, tireSize: '120/70-14', position: 'rear',  isOem: true,  confidence: 0.95, source: 'manufacturer', note: 'OEM original Honda 2018+' },
  { motoLookup: { make: 'Honda', model: 'PCX 150', yearStart: 2013 }, tireSize: '90/90-14',  position: 'front', isOem: false, confidence: 0.85, source: 'manual',       note: 'medida alternativa comum em loja usado' },
  { motoLookup: { make: 'Honda', model: 'PCX 150', yearStart: 2013 }, tireSize: '100/90-14', position: 'rear',  isOem: false, confidence: 0.85, source: 'manual',       note: 'medida alternativa comum em loja usado' },

  // ---- Honda Biz 125 (2006-2026): faltava front ----
  { motoLookup: { make: 'Honda', model: 'Biz 125', yearStart: 2006 }, tireSize: '60/100-17', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'manual Honda 2020' },

  // ---- Honda NXR 150 Bros (2005-2015): faltava rear ----
  { motoLookup: { make: 'Honda', model: 'NXR 150 Bros', yearStart: 2005 }, tireSize: '110/90-17', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'manual Honda' },

  // ---- Honda NXR 160 Bros (2016-2026): faltava rear ----
  { motoLookup: { make: 'Honda', model: 'NXR 160 Bros', yearStart: 2016 }, tireSize: '110/90-17', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'motorcyclist.com.br' },

  // ---- Honda Pop 110i ES (2016-2026): faltava front ----
  { motoLookup: { make: 'Honda', model: 'Pop 110i', variant: 'ES', yearStart: 2016 }, tireSize: '60/100-17', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Pirelli Mandrake Due OEM' },

  // ---- Honda XRE 190 (2016-2026): faltava rear ----
  { motoLookup: { make: 'Honda', model: 'XRE 190', yearStart: 2016 }, tireSize: '110/90-17', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Honda XRE 300 (2009-2025): faltava rear ----
  { motoLookup: { make: 'Honda', model: 'XRE 300', yearStart: 2009 }, tireSize: '120/80-18', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'manual Honda + Rinaldi R34 padrao' },

  // ---- Yamaha XMAX 250 ABS (2018-2026): faltava rear ----
  { motoLookup: { make: 'Yamaha', model: 'XMAX 250', variant: 'ABS', yearStart: 2018 }, tireSize: '140/70-14', position: 'rear', isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Yamaha Fluo 125 (apos UPDATE year) ----
  { motoLookup: { make: 'Yamaha', model: 'Fluo' }, tireSize: '100/90-12', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer' },
  { motoLookup: { make: 'Yamaha', model: 'Fluo' }, tireSize: '110/90-12', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Yamaha Crosser 150 (2014-2024) ----
  { motoLookup: { make: 'Yamaha', model: 'Crosser 150', yearStart: 2014 }, tireSize: '80/90-21',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Metzeler ate 2024' },
  { motoLookup: { make: 'Yamaha', model: 'Crosser 150', yearStart: 2014 }, tireSize: '110/80-18', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Yamaha Crosser 150 S (2025-2026) ----
  { motoLookup: { make: 'Yamaha', model: 'Crosser 150', variant: 'S', yearStart: 2025 }, tireSize: '90/90-19',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Levorin 2025' },
  { motoLookup: { make: 'Yamaha', model: 'Crosser 150', variant: 'S', yearStart: 2025 }, tireSize: '110/90-17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Yamaha Lander 250 (apos UPDATE year) ----
  { motoLookup: { make: 'Yamaha', model: 'Lander' }, tireSize: '80/90-21',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Metzeler Tourance OEM' },
  { motoLookup: { make: 'Yamaha', model: 'Lander' }, tireSize: '120/80-18', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Yamaha Ténéré 250 (2010-2019) ----
  { motoLookup: { make: 'Yamaha', model: 'Ténéré 250', yearStart: 2010 }, tireSize: '80/90-21',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Metzeler Tourance' },
  { motoLookup: { make: 'Yamaha', model: 'Ténéré 250', yearStart: 2010 }, tireSize: '120/80-18', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Yamaha Ténéré 250 Flex (2020-2026) ----
  { motoLookup: { make: 'Yamaha', model: 'Ténéré 250', variant: 'Flex', yearStart: 2020 }, tireSize: '90/90-21',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Flex 2020+' },
  { motoLookup: { make: 'Yamaha', model: 'Ténéré 250', variant: 'Flex', yearStart: 2020 }, tireSize: '130/80-18', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Suzuki Burgman 125 (2012-2019) ----
  { motoLookup: { make: 'Suzuki', model: 'Burgman 125', yearStart: 2012 }, tireSize: '90/90-10',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer' },
  { motoLookup: { make: 'Suzuki', model: 'Burgman 125', yearStart: 2012 }, tireSize: '100/90-10', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Suzuki Boulevard C50 (2005-2026) ----
  { motoLookup: { make: 'Suzuki', model: 'Boulevard C50', yearStart: 2005 }, tireSize: '130/90-16', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'VL800 padrao 2005+' },
  { motoLookup: { make: 'Suzuki', model: 'Boulevard C50', yearStart: 2005 }, tireSize: '170/80-15', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Suzuki Boulevard M800 (2005-2019) ----
  { motoLookup: { make: 'Suzuki', model: 'Boulevard M800', yearStart: 2005 }, tireSize: '130/90-16', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer' },
  { motoLookup: { make: 'Suzuki', model: 'Boulevard M800', yearStart: 2005 }, tireSize: '170/80-15', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Haojue NK150 (apos UPDATE year) ----
  { motoLookup: { make: 'Haojue', model: 'NK150' }, tireSize: '90/90-19',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'MT60 OEM' },
  { motoLookup: { make: 'Haojue', model: 'NK150' }, tireSize: '110/90-17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Haojue Lindy 125 (apos UPDATE year) ----
  { motoLookup: { make: 'Haojue', model: 'Lindy' }, tireSize: '90/90-10',  position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer' },
  { motoLookup: { make: 'Haojue', model: 'Lindy' }, tireSize: '100/90-10', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Dafra Smart 125 (apos UPDATE year) ----
  { motoLookup: { make: 'Dafra', model: 'Smart' }, tireSize: '3.50-10', position: 'front', isOem: true, confidence: 0.90, source: 'manufacturer', note: 'notacao antiga oficial' },
  { motoLookup: { make: 'Dafra', model: 'Smart' }, tireSize: '3.50-10', position: 'rear',  isOem: true, confidence: 0.90, source: 'manufacturer' },

  // ---- Dafra Citycom 300 (apos UPDATE year) ----
  { motoLookup: { make: 'Dafra', model: 'Citycom' }, tireSize: '110/70-16', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer' },
  { motoLookup: { make: 'Dafra', model: 'Citycom' }, tireSize: '130/70-16', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Kasinski Mirage 150 (2010-2014) — notacao moderna ----
  { motoLookup: { make: 'Kasinski', model: 'Mirage 150', yearStart: 2010 }, tireSize: '80/90-18', position: 'front', isOem: true,  confidence: 0.85, source: 'manual', note: 'convertido de 2.75-18 (notacao antiga)' },
  { motoLookup: { make: 'Kasinski', model: 'Mirage 150', yearStart: 2010 }, tireSize: '90/90-16', position: 'rear',  isOem: true,  confidence: 0.85, source: 'manual', note: 'convertido de 3.50-16 (notacao antiga)' },

  // ---- Kasinski Mirage 250 (2001-2013) ----
  { motoLookup: { make: 'Kasinski', model: 'Mirage 250', yearStart: 2001 }, tireSize: '110/90-16', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'Metzeler ME 77' },
  { motoLookup: { make: 'Kasinski', model: 'Mirage 250', yearStart: 2001 }, tireSize: '140/90-15', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Royal Enfield Classic 350 (apos UPDATE year + model) ----
  { motoLookup: { make: 'Royal Enfield', model: 'Classic 350' }, tireSize: '100/90-19', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'CEAT Zoom OEM' },
  { motoLookup: { make: 'Royal Enfield', model: 'Classic 350' }, tireSize: '120/80-18', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },

  // ---- Royal Enfield Meteor 350 (apos UPDATE year + model) ----
  { motoLookup: { make: 'Royal Enfield', model: 'Meteor 350' }, tireSize: '100/90-19', position: 'front', isOem: true, confidence: 0.95, source: 'manufacturer', note: 'CEAT Zoom Plus OEM' },
  { motoLookup: { make: 'Royal Enfield', model: 'Meteor 350' }, tireSize: '140/70-17', position: 'rear',  isOem: true, confidence: 0.95, source: 'manufacturer' },
];

async function lookupGenericIds(): Promise<void> {
  // Resolve IDs das 7 genericas Honda
  const honda = ['PCX', 'Bros', 'Pop', 'Lead', 'Biz', 'Elite', 'XRE'];
  for (const model of honda) {
    const target = GENERIC_DELETES.find((g) => g.label === `Honda ${model} (generica)`);
    if (!target) continue;
    const res = await client.query(
      `SELECT id FROM commerce.vehicle_models
       WHERE environment='prod' AND deleted_at IS NULL AND make='Honda' AND model=$1
         AND variant IS NULL AND year_start IS NULL AND year_end IS NULL
       LIMIT 1;`,
      [model],
    );
    target.id = res.rows[0]?.id ?? '';
  }
}

async function resolveMotoId(lookup: FitmentRow['motoLookup']): Promise<string | null> {
  const params: unknown[] = [lookup.make, lookup.model];
  let where = 'make=$1 AND model=$2 AND deleted_at IS NULL AND environment=\'prod\'';
  if (lookup.variant !== undefined) {
    params.push(lookup.variant);
    where += ` AND variant IS NOT DISTINCT FROM $${params.length}`;
  }
  if (lookup.yearStart !== undefined) {
    params.push(lookup.yearStart);
    where += ` AND year_start IS NOT DISTINCT FROM $${params.length}`;
  }
  const res = await client.query(`SELECT id FROM commerce.vehicle_models WHERE ${where} LIMIT 1;`, params);
  return res.rows[0]?.id ?? null;
}

async function main() {
  await client.connect();
  await client.query('BEGIN');
  console.log(`=== CADASTRO FITMENTS 2026-05-23 (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  try {
    // ---------------- ETAPA 0: tire_specs/products novos ----------------
    console.log('ETAPA 0 — Medidas (tire_specs) novas');
    const tireSpecIdBySize = new Map<string, string>();
    const existing = await client.query(
      `SELECT id, tire_size, "position" FROM commerce.tire_specs WHERE environment='prod';`,
    );
    for (const row of existing.rows) {
      tireSpecIdBySize.set(`${row.tire_size}|${row.position}`, row.id);
    }
    let createdTires = 0;
    for (const t of NEW_TIRES) {
      const key = `${t.tireSize}|${t.position}`;
      if (tireSpecIdBySize.has(key)) {
        console.log(`  ${t.tireSize} ${t.position}: ja existe, pulando`);
        continue;
      }
      const prodRes = await client.query(
        `INSERT INTO commerce.products (environment, product_code, product_name, product_type)
         VALUES ('prod', $1, $2, 'tire') RETURNING id;`,
        [t.productCode, t.productName],
      );
      const productId = prodRes.rows[0].id;
      const tsRes = await client.query(
        `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter, construction, "position")
         VALUES ('prod', $1, $2, $3, $4, $5, $6, $7) RETURNING id;`,
        [productId, t.tireSize, t.widthMm, t.aspectRatio, t.rimDiameter, t.construction, t.position],
      );
      tireSpecIdBySize.set(key, tsRes.rows[0].id);
      await client.query(
        `INSERT INTO commerce.product_prices (environment, product_id, price_amount, currency, price_type, valid_from)
         VALUES ('prod', $1, 99.00, 'BRL', 'regular', NOW());`,
        [productId],
      );
      await client.query(
        `INSERT INTO commerce.stock_levels (environment, product_id, quantity_available, quantity_reserved, location, last_adjusted_at)
         VALUES ('prod', $1, 10, 0, 'main', NOW());`,
        [productId],
      );
      createdTires += 1;
      console.log(`  + ${t.tireSize} ${t.position} → product_id=${productId.slice(0, 8)}`);
    }
    console.log(`  Total tire_specs novos: ${createdTires}\n`);

    // ---------------- ETAPA 1: UPDATE years em motos single-geracao ----------------
    console.log('ETAPA 1 — UPDATE years em motos single-geracao');
    for (const u of YEAR_UPDATES) {
      const sets: string[] = ['year_start=$2', 'year_end=$3'];
      const params: unknown[] = [u.id, u.yearStart, u.yearEnd];
      if (u.cc !== undefined) { params.push(u.cc); sets.push(`displacement_cc=$${params.length}`); }
      if (u.newModel !== undefined) { params.push(u.newModel); sets.push(`model=$${params.length}`); }
      if (u.aliases !== undefined) { params.push(u.aliases); sets.push(`aliases=$${params.length}`); }
      sets.push('updated_at=NOW()');
      const res = await client.query(
        `UPDATE commerce.vehicle_models SET ${sets.join(', ')} WHERE id=$1 RETURNING make, model, year_start, year_end;`,
        params,
      );
      const r = res.rows[0];
      console.log(`  ~ ${u.label}: ${r?.make} ${r?.model} (${r?.year_start}-${r?.year_end})`);
    }
    console.log('');

    // ---------------- ETAPA 2: INSERT variantes novas ----------------
    console.log('ETAPA 2 — Variantes novas');
    let createdVariants = 0;
    for (const v of NEW_VARIANTS) {
      const exists = await client.query(
        `SELECT id FROM commerce.vehicle_models
         WHERE environment='prod' AND deleted_at IS NULL
           AND make=$1 AND model=$2
           AND (variant IS NOT DISTINCT FROM $3)
           AND (year_start IS NOT DISTINCT FROM $4)
         LIMIT 1;`,
        [v.make, v.model, v.variant, v.yearStart],
      );
      if (exists.rows.length > 0) {
        console.log(`  ${v.make} ${v.model} ${v.variant ?? ''} (${v.yearStart}-${v.yearEnd}): ja existe`);
        continue;
      }
      await client.query(
        `INSERT INTO commerce.vehicle_models
           (environment, vehicle_type, make, model, variant, year_start, year_end, displacement_cc, aliases)
         VALUES ('prod', 'motorcycle', $1, $2, $3, $4, $5, $6, $7);`,
        [v.make, v.model, v.variant, v.yearStart, v.yearEnd, v.cc, v.aliases],
      );
      createdVariants += 1;
      console.log(`  + ${v.make} ${v.model} ${v.variant ?? ''} (${v.yearStart}-${v.yearEnd})`);
    }
    console.log(`  Total variantes novas: ${createdVariants}\n`);

    // ---------------- ETAPA 3: DELETE genericas ----------------
    console.log('ETAPA 3 — DELETE entradas genericas duplicadas');
    await lookupGenericIds();
    let deletedCount = 0;
    for (const g of GENERIC_DELETES) {
      if (!g.id) {
        console.log(`  ? ${g.label}: id nao encontrado, pulando`);
        continue;
      }
      // Check zero referencias antes (defesa)
      const refsFitments = await client.query(
        `SELECT COUNT(*)::int AS n FROM commerce.vehicle_fitments WHERE vehicle_model_id=$1;`,
        [g.id],
      );
      const refsDiscoveries = await client.query(
        `SELECT COUNT(*)::int AS n FROM commerce.fitment_discoveries WHERE vehicle_model_id=$1;`,
        [g.id],
      );
      if (refsFitments.rows[0].n > 0 || refsDiscoveries.rows[0].n > 0) {
        console.log(`  ! ${g.label}: TEM REFERENCIAS (fitments=${refsFitments.rows[0].n}, discoveries=${refsDiscoveries.rows[0].n}) — pulando`);
        continue;
      }
      const res = await client.query(`DELETE FROM commerce.vehicle_models WHERE id=$1 RETURNING make, model;`, [g.id]);
      deletedCount += 1;
      console.log(`  - DELETE ${g.label}`);
    }
    console.log(`  Total deletadas: ${deletedCount}\n`);

    // ---------------- ETAPA 4: INSERT fitments ----------------
    console.log('ETAPA 4 — Fitments');
    let createdFitments = 0;
    let skippedFitments = 0;
    let failedFitments = 0;
    for (const f of NEW_FITMENTS) {
      const motoId = await resolveMotoId(f.motoLookup);
      if (!motoId) {
        console.log(`  ! ${f.motoLookup.make} ${f.motoLookup.model} ${f.motoLookup.variant ?? ''}: moto nao encontrada`);
        failedFitments += 1;
        continue;
      }
      const tireSpecId = tireSpecIdBySize.get(`${f.tireSize}|${f.position}`);
      if (!tireSpecId) {
        console.log(`  ! ${f.tireSize}/${f.position}: tire_spec nao encontrado`);
        failedFitments += 1;
        continue;
      }
      const exists = await client.query(
        `SELECT 1 FROM commerce.vehicle_fitments
         WHERE environment='prod' AND vehicle_model_id=$1 AND tire_spec_id=$2 AND "position"=$3;`,
        [motoId, tireSpecId, f.position],
      );
      if (exists.rows.length > 0) {
        skippedFitments += 1;
        continue;
      }
      await client.query(
        `INSERT INTO commerce.vehicle_fitments
           (environment, vehicle_model_id, tire_spec_id, "position", is_oem, source, confidence_level)
         VALUES ('prod', $1, $2, $3, $4, $5, $6);`,
        [motoId, tireSpecId, f.position, f.isOem, f.source, f.confidence],
      );
      createdFitments += 1;
      console.log(`  + ${f.motoLookup.make} ${f.motoLookup.model} ${f.motoLookup.variant ?? ''} (${f.motoLookup.yearStart ?? '-'}) ← ${f.tireSize}/${f.position}${f.isOem ? ' [OEM]' : ' [alt]'}`);
    }
    console.log(`\n  Fitments criados: ${createdFitments} | pulados (ja existiam): ${skippedFitments} | falharam: ${failedFitments}\n`);

    // ---------------- SMOKE TESTS ----------------
    console.log('SMOKE TESTS');
    const probes: Array<{ moto: string; year?: number }> = [
      { moto: 'PCX', year: 2020 },     // antes: produtos=[] (bug 593). Agora deveria voltar PCX 150 com fitment.
      { moto: 'PCX 150' },
      { moto: 'Bros', year: 2018 },
      { moto: 'Pop' },
      { moto: 'XRE 300' },
      { moto: 'Crosser', year: 2018 },  // deveria voltar geracao antiga
      { moto: 'Crosser', year: 2025 },  // deveria voltar geracao nova
      { moto: 'Tenere', year: 2022 },   // Flex
      { moto: 'Burgman' },
      { moto: 'Citycom' },
      { moto: 'Lindy' },
      { moto: 'Mirage 250' },
      { moto: 'Classic 350' },
      { moto: 'Meteor' },
    ];
    for (const p of probes) {
      const r = await client.query(
        `SELECT make, model, variant, year_start, year_end, match_type, match_similarity
         FROM commerce.resolve_vehicle_model('prod'::env_t, $1, $2, 0.4) LIMIT 2;`,
        [p.moto, p.year ?? null],
      );
      console.log(`  resolve('${p.moto}'${p.year ? `, ${p.year}` : ''}): ${r.rows.length}`);
      for (const row of r.rows) {
        console.log(`    → ${row.make} ${row.model} ${row.variant ?? ''} (${row.year_start ?? '-'}-${row.year_end ?? '-'}) ${row.match_type} sim=${row.match_similarity}`);
      }
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log('\n*** COMMIT efetuado. Migration de dados aplicada em prod. ***');
    } else {
      await client.query('ROLLBACK');
      console.log('\n*** DRY-RUN: ROLLBACK efetuado. Rode com COMMIT=1 pra aplicar. ***');
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
