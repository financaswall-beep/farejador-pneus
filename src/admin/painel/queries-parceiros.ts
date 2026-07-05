// Obra 300 (2026-07-05): fatia do banco da MATRIZ — criar parceiro + candidaturas (aprovar/rejeitar).
// VERBATIM das linhas 712-982 do queries.ts pré-obra (commit 2628748).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';
import { hashPassword } from '../../parceiro/password.js';

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
export async function createPartnerUnit(
  input: CreatePartnerInput,
  dbPool: Pool = defaultPool,
): Promise<CreatePartnerResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const baseSlug = slugify(input.slug || input.trade_name);
  if (!baseSlug) throw new Error('trade_name_or_slug_required');
  const explicitSlug = !!input.slug;

  const client: PoolClient = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const slugExists = async (s: string): Promise<boolean> => {
      const r = await client.query(
        `SELECT 1 FROM network.partner_units WHERE environment = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
        [environment, s],
      );
      return (r.rowCount ?? 0) > 0;
    };

    let slug = baseSlug;
    if (await slugExists(slug)) {
      if (explicitSlug) {
        await client.query('ROLLBACK');
        return { already_exists: true, slug };
      }
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
         (environment, partner_id, unit_id, slug, display_name, address, phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING id`,
      [environment, partnerId, unitId, slug, input.trade_name, input.address ?? null, input.whatsapp_phone ?? null],
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

    await client.query('COMMIT');
    return {
      already_exists: false,
      partner_id: partnerId,
      unit_id: unitId,
      partner_unit_id: partnerUnitId,
      slug,
      token,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Candidaturas de parceiro (Etapa 3 — funil de recrutamento) ───────────────
export interface PartnerApplicationInput {
  environment?: 'prod' | 'test';
  trade_name: string;
  responsible_name?: string | null;
  whatsapp_phone?: string | null;
  email?: string | null;
  address?: string | null;
  municipios?: string | null;
  message?: string | null;
}

/** Insere uma candidatura pública (status=pending). Sem auth — vem do formulário público. */
export async function createPartnerApplication(
  input: PartnerApplicationInput,
  dbPool: Pool = defaultPool,
): Promise<{ id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ id: string }>(
    `INSERT INTO network.partner_applications
       (environment, trade_name, responsible_name, whatsapp_phone, email, address, municipios, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      environment, input.trade_name.trim(),
      input.responsible_name?.trim() || null, input.whatsapp_phone?.trim() || null,
      input.email?.trim() || null, input.address?.trim() || null,
      input.municipios?.trim() || null, input.message?.trim() || null,
    ],
  );
  return { id: r.rows[0]!.id };
}

/** Lista candidaturas pra fila da matriz (default: só pendentes). */
export async function listPartnerApplications(
  status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending',
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const r = await dbPool.query(
    `SELECT id, trade_name, responsible_name, whatsapp_phone, email, address, municipios, message,
            status, created_at, reviewed_by, reviewed_at, review_notes, created_partner_unit_id
     FROM network.partner_applications
     WHERE environment = $1 AND ($2 = 'all' OR status = $2)
     ORDER BY created_at DESC LIMIT 100`,
    [env.FAREJADOR_ENV, status],
  );
  return r.rows;
}

export interface ApproveApplicationInput {
  application_id: string;
  actor_label: string;
  municipios: string[];                 // cobertura REAL definida pelo dono na aprovação
  commission_percent?: number | null;   // termos comerciais: definidos pelo dono aqui
  monthly_fee?: number | null;
  commercial_model?: string | null;
  slug?: string | null;
}

/** Aprova: cria o parceiro (reusa createPartnerUnit) e marca a candidatura como approved. */
export async function approvePartnerApplication(
  input: ApproveApplicationInput,
  dbPool: Pool = defaultPool,
): Promise<CreatePartnerResult & { application_id: string }> {
  const appRes = await dbPool.query<{
    environment: 'prod' | 'test'; trade_name: string; responsible_name: string | null;
    whatsapp_phone: string | null; email: string | null; address: string | null; status: string;
  }>(
    `SELECT environment, trade_name, responsible_name, whatsapp_phone, email, address, status
     FROM network.partner_applications WHERE id = $1 AND environment = $2`,
    [input.application_id, env.FAREJADOR_ENV],
  );
  const app = appRes.rows[0];
  if (!app) throw new Error('application_not_found');
  if (app.status !== 'pending') throw new Error('application_not_pending');

  const created = await createPartnerUnit({
    environment: app.environment,
    trade_name: app.trade_name,
    responsible_name: app.responsible_name,
    whatsapp_phone: app.whatsapp_phone,
    email: app.email,
    address: app.address,
    commission_percent: input.commission_percent ?? null,
    monthly_fee: input.monthly_fee ?? null,
    commercial_model: input.commercial_model ?? null,
    municipios: input.municipios,
    slug: input.slug ?? null,
    actor_label: input.actor_label,
  }, dbPool);

  if (!created.already_exists) {
    await dbPool.query(
      `UPDATE network.partner_applications
       SET status='approved', reviewed_by=$1, reviewed_at=now(), created_partner_unit_id=$2
       WHERE id=$3`,
      [input.actor_label, created.partner_unit_id ?? null, input.application_id],
    );
  }
  return { ...created, application_id: input.application_id };
}

/** Recusa uma candidatura pendente. */
export async function rejectPartnerApplication(
  applicationId: string,
  actorLabel: string,
  notes: string | null,
  dbPool: Pool = defaultPool,
): Promise<{ rejected: boolean }> {
  const r = await dbPool.query(
    `UPDATE network.partner_applications
     SET status='rejected', reviewed_by=$1, reviewed_at=now(), review_notes=$2
     WHERE id=$3 AND environment=$4 AND status='pending'`,
    [actorLabel, notes, applicationId, env.FAREJADOR_ENV],
  );
  return { rejected: (r.rowCount ?? 0) > 0 };
}

// ─── ATACADO (Fase 1): venda de atacado da Matriz + ranking de recompra ───────
// Dado SÓ da matriz (migration 0110): a matriz conecta como owner (defaultPool),
// sem grant pro parceiro. Comprador = parceiro da rede (partner_id) OU só-atacado
// (cadastro leve nome+telefone). Preço DIGITADO por venda. NÃO mexe em estoque/financeiro.

