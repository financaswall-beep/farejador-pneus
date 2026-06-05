/**
 * Fixtures pra testes de integração do Portal Parceiro.
 *
 * Cria um cenário mínimo isolado: core.unit + network.partner + network.partner_unit
 * + network.partner_access_tokens + alguns items de estoque. Cada fixture usa slug
 * UUID-based pra nunca colidir com outras fixtures rodando em paralelo.
 *
 * Não toca em bot/atendente/planner/organizadora — só nas tabelas do silo do parceiro.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface PartnerFixtureOptions {
  slugSuffix?: string;
  initialStockQty?: number;
  partnerStatus?: 'credentialing' | 'active' | 'suspended';
  unitStatus?: 'credentialing' | 'active' | 'suspended';
  revokeToken?: boolean;
  /** Etapa 4: papel do token. Default 'owner' (igual ao default da coluna). */
  role?: 'owner' | 'funcionario';
}

export interface PartnerFixture {
  partnerId: string;
  partnerUnitId: string;
  unitId: string;
  slug: string;
  tokenPlain: string;
  tokenHash: string;
  /**
   * Item de estoque pronto pra venda. quantity_on_hand = initialStockQty (default 10).
   */
  stockId: string;
  stockItemName: string;
  /**
   * PartnerContext montado igual ao que auth.ts produz — pronto pra passar nas
   * funções de queries.ts.
   */
  ctx: {
    environment: 'prod' | 'test';
    partnerId: string;
    partnerUnitId: string;
    unitId: string;
    slug: string;
    partnerName: string;
    unitName: string;
    role: 'owner' | 'funcionario';
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function createPartnerFixture(
  pool: Pool,
  opts: PartnerFixtureOptions = {},
): Promise<PartnerFixture> {
  const suffix = opts.slugSuffix ?? randomUUID().slice(0, 8);
  const slug = `pf-${suffix}`;
  const initialQty = opts.initialStockQty ?? 10;
  const partnerStatus = opts.partnerStatus ?? 'active';
  const unitStatus = opts.unitStatus ?? 'active';

  // 1. core.units
  const unit = await pool.query<{ id: string }>(
    `INSERT INTO core.units (environment, slug, name, is_active)
     VALUES ('test', $1, $2, true)
     RETURNING id`,
    [slug, `Unidade Teste ${suffix}`],
  );
  const unitId = unit.rows[0]!.id;

  // 2. network.partners
  const partner = await pool.query<{ id: string }>(
    `INSERT INTO network.partners (
       environment, legal_name, trade_name, document_number, status, commercial_model
     ) VALUES ('test', $1, $2, $3, $4, 'commission')
     RETURNING id`,
    [
      `Razao Social ${suffix}`,
      `Teste ${suffix}`,
      `cnpj-${suffix}`,
      partnerStatus,
    ],
  );
  const partnerId = partner.rows[0]!.id;

  // 3. network.partner_units
  const partnerUnit = await pool.query<{ id: string }>(
    `INSERT INTO network.partner_units (
       environment, partner_id, unit_id, slug, display_name, status
     ) VALUES ('test', $1, $2, $3, $4, $5)
     RETURNING id`,
    [partnerId, unitId, slug, `Loja Teste ${suffix}`, unitStatus],
  );
  const partnerUnitId = partnerUnit.rows[0]!.id;

  // 4. network.partner_access_tokens
  const tokenPlain = `token-${suffix}-${randomUUID()}`;
  const tokenHash = sha256(tokenPlain);
  const role = opts.role ?? 'owner';
  await pool.query(
    `INSERT INTO network.partner_access_tokens (
       environment, partner_unit_id, token_hash, label, created_by, revoked_at, role
     ) VALUES ('test', $1, $2, $3, 'fixture', $4, $5)`,
    [
      partnerUnitId,
      tokenHash,
      `token piloto ${suffix}`,
      opts.revokeToken ? new Date() : null,
      role,
    ],
  );

  // 5. commerce.partner_stock_levels — 1 item rastreado, com saldo
  const stockItemName = `Pneu Teste ${suffix}`;
  const stock = await pool.query<{ id: string }>(
    `INSERT INTO commerce.partner_stock_levels (
       environment, unit_id, item_name, tire_size, brand,
       quantity_on_hand, minimum_quantity, average_cost, sale_price,
       is_tracked, stock_status, updated_by
     ) VALUES ('test', $1, $2, '90/90-18', 'Michelin',
               $3, 2, 80, 150, true, $4, 'fixture')
     RETURNING id`,
    [unitId, stockItemName, initialQty, initialQty > 0 ? 'in_stock' : 'out_of_stock'],
  );
  const stockId = stock.rows[0]!.id;

  return {
    partnerId,
    partnerUnitId,
    unitId,
    slug,
    tokenPlain,
    tokenHash,
    stockId,
    stockItemName,
    ctx: {
      environment: 'test',
      partnerId,
      partnerUnitId,
      unitId,
      slug,
      partnerName: `Teste ${suffix}`,
      unitName: `Loja Teste ${suffix}`,
      role,
    },
  };
}

/**
 * Lê quantity_on_hand de um stock por id.
 */
export async function getStockQty(pool: Pool, stockId: string): Promise<number> {
  const r = await pool.query<{ q: number }>(
    `SELECT quantity_on_hand AS q FROM commerce.partner_stock_levels WHERE id = $1`,
    [stockId],
  );
  return Number(r.rows[0]?.q ?? -1);
}
