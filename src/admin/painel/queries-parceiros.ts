// Obra 300 (2026-07-05): fatia do banco da MATRIZ — criar parceiro + candidaturas (aprovar/rejeitar).
// VERBATIM das linhas 712-982 do queries.ts pré-obra (commit 2628748).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface CreatePartnerInput {
  environment?: 'prod' | 'test';
  trade_name: string;                 // nome fantasia (obrigatório)
  legal_name?: string | null;
  document_number?: string | null;
  responsible_name?: string | null;
  whatsapp_phone?: string | null;
  email?: string | null;
  address?: string | null;
  commercial_model?: string | null;   // termos comerciais: definidos pela matriz na criação/aprovação
  commission_percent?: number | null;
  monthly_fee?: number | null;
  municipios: string[];               // cobertura — cidades que o parceiro atende
  slug?: string | null;               // opcional; se vazio, gerado do trade_name
  actor_label: string;
}

export interface CreatePartnerResult {
  already_exists: boolean;
  partner_id?: string;
  unit_id?: string;
  partner_unit_id?: string;
  slug?: string;
  token?: string;                     // texto puro, UMA vez (só quando criado de fato)
}

interface CreatePartnerUnitOptions { sourceApplicationId?: string | null }

function slugify(s: string): string {
  return (s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeMunicipio(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/**
 * Cria um parceiro completo (Etapa 1 do onboarding) numa transação: unidade (core.units)
 * + parceiro (network.partners) + vínculo (network.partner_units) + LOGIN (token, role=owner)
 * + cobertura (network.unit_coverage). Em TS com a conexão privilegiada do backend —
 * sem SECURITY DEFINER (evita o footgun; a função vive atrás do endpoint admin).
 *
 * Ajustes de revisão (Codex 2026-06-04):
 *  - token NÃO é recuperável: só o hash fica no banco. Slug explícito que já existe →
 *    `already_exists: true` (não duplica, não finge devolver token). Reemitir token = ação à parte.
 *  - slug auto-gerado resolve colisão com sufixo numérico.
 */
export async function createPartnerUnitWithClient(
  input: CreatePartnerInput,
  client: PoolClient,
  options: CreatePartnerUnitOptions = {},
): Promise<CreatePartnerResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const baseSlug = slugify(input.slug || input.trade_name);
  if (!baseSlug) throw new Error('trade_name_or_slug_required');
  const explicitSlug = !!input.slug;

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`partner-slug:${environment}:${baseSlug}`]);
  const slugExists = async (s: string): Promise<boolean> => {
    const r = await client.query(
      `SELECT 1 FROM network.partner_units WHERE environment=$1 AND slug=$2 AND deleted_at IS NULL LIMIT 1`,
      [environment, s]);
    return (r.rowCount ?? 0) > 0;
  };
  let slug = baseSlug;
  if (await slugExists(slug)) {
    if (explicitSlug) return { already_exists: true, slug };
    let n = 2;
    while (await slugExists(`${baseSlug}-${n}`)) n += 1;
    slug = `${baseSlug}-${n}`;
  }

  const unitRes = await client.query<{ id: string }>(
      `INSERT INTO core.units (environment, slug, name, address, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [environment, slug, input.trade_name, input.address ?? null, input.whatsapp_phone ?? null],
    );
  const unitId = unitRes.rows[0]!.id;

  const partnerRes = await client.query<{ id: string }>(
      `INSERT INTO network.partners
         (environment, legal_name, trade_name, document_number, responsible_name,
          whatsapp_phone, email, address, status, commercial_model, commission_percent, monthly_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11) RETURNING id`,
      [
        environment, input.legal_name ?? input.trade_name, input.trade_name,
        input.document_number ?? null, input.responsible_name ?? null,
        input.whatsapp_phone ?? null, input.email ?? null, input.address ?? null,
        input.commercial_model ?? 'commission', input.commission_percent ?? null, input.monthly_fee ?? null,
      ],
    );
  const partnerId = partnerRes.rows[0]!.id;

  const puRes = await client.query<{ id: string }>(
      `INSERT INTO network.partner_units
         (environment, partner_id, unit_id, slug, display_name, address, phone, status, source_application_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8) RETURNING id`,
      [environment, partnerId, unitId, slug, input.trade_name, input.address ?? null,
       input.whatsapp_phone ?? null, options.sourceApplicationId ?? null],
    );
  const partnerUnitId = puRes.rows[0]!.id;

    // Login do dono: token em texto só agora; banco guarda só o hash. role='owner'.
  const token = randomBytes(32).toString('hex');
  await client.query(
      `INSERT INTO network.partner_access_tokens
         (environment, partner_unit_id, token_hash, label, created_by, role)
       VALUES ($1, $2, network.hash_partner_token($3), $4, $5, 'owner')`,
      [environment, partnerUnitId, token, `cadastro_${new Date().toISOString().slice(0, 10)}`, input.actor_label],
    );

  for (const m of input.municipios) {
    const mn = normalizeMunicipio(m);
    if (!mn) continue;
    await client.query(
        // ON CONFLICT casa com o índice funcional de 4 colunas da 0087
        // (environment, unit_id, municipio, coalesce(neighborhood_canonical,'')).
        // Cadastro insere cobertura de cidade inteira (bairro NULL → coalesce '').
        `INSERT INTO network.unit_coverage (environment, unit_id, municipio)
         VALUES ($1, $2, $3)
         ON CONFLICT (environment, unit_id, municipio, coalesce(neighborhood_canonical, '')) DO NOTHING`,
        [environment, unitId, mn],
    );
  }

  return { already_exists: false, partner_id: partnerId, unit_id: unitId,
    partner_unit_id: partnerUnitId, slug, token };
}

export async function createPartnerUnit(
  input: CreatePartnerInput,
  dbPool: Pool = defaultPool,
): Promise<CreatePartnerResult> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await createPartnerUnitWithClient(input, client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
