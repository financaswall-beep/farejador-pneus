/**
 * CHAVE DA REDE (0165) — "Recebe pedidos da Rede?" por unidade parceira.
 *
 * A Matriz liga/desliga a participação da loja no roteamento do bot. Desligada,
 * a loja vira "só sistema": o painel dela continua INTEIRO (login, caixa,
 * estoque, clientes, financeiro, histórico e pedidos ANTIGOS da Rede), mas o bot
 * nunca mais a escolhe pra pedido/indicação/reserva/foto — o filtro vive no SQL
 * dos seletores em `atendente-v2/fulfillment.ts` (§CHAVE DA REDE) e `agent.ts`.
 *
 * Escrita SÓ pela Matriz (a rota é owner-only) e sempre auditada. O parceiro não
 * tem grant de escrita em partner_units — a 0165 prova isso dentro da migration.
 */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import {
  normalizeMunicipalityKey,
  resolveNetworkMunicipality,
} from '../../network/municipality-catalog.js';

export interface SetNetworkOrdersResult {
  updated: boolean;
  /** só quando updated=false */
  reason?: 'not_found';
  /** valor final gravado (= o pedido, quando updated) */
  accepts_network_orders?: boolean;
  /** false quando o valor já era esse (repetir é seguro e NÃO gera linha de auditoria) */
  changed?: boolean;
}

/**
 * Grava `network.partner_units.accepts_network_orders` da unidade.
 *
 * Idempotente: mandar o mesmo valor devolve updated=true / changed=false sem
 * sujar a trilha. Só a mudança REAL vira `audit.events`
 * (event_type='partner_network_orders_updated', com valor antes e depois).
 *
 * Tudo numa transação com FOR UPDATE na linha: dois cliques simultâneos não
 * geram trilha torta.
 */
export async function setPartnerUnitNetworkOrders(
  environment: 'prod' | 'test',
  partnerUnitId: string,
  acceptsNetworkOrders: boolean,
  actorLabel: string,
  dbPool: Pool = defaultPool,
): Promise<SetNetworkOrdersResult> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query<{ accepts_network_orders: boolean; slug: string }>(
      `SELECT accepts_network_orders, slug
         FROM network.partner_units
        WHERE id = $1 AND environment = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [partnerUnitId, environment],
    );
    if (before.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { updated: false, reason: 'not_found' };
    }
    const previous = before.rows[0]!.accepts_network_orders;
    if (previous === acceptsNetworkOrders) {
      await client.query('COMMIT');
      return { updated: true, changed: false, accepts_network_orders: acceptsNetworkOrders };
    }

    await client.query(
      `UPDATE network.partner_units
          SET accepts_network_orders = $3
        WHERE id = $1 AND environment = $2`,
      [partnerUnitId, environment, acceptsNetworkOrders],
    );
    await client.query(
      `INSERT INTO audit.events
         (environment, domain, entity_table, entity_id, event_type, actor_label,
          payload_before, payload_after)
       VALUES ($1,'network','network.partner_units',$2,'partner_network_orders_updated',$3,
               $4::jsonb, $5::jsonb)`,
      [
        environment,
        partnerUnitId,
        actorLabel,
        JSON.stringify({ accepts_network_orders: previous }),
        JSON.stringify({ accepts_network_orders: acceptsNetworkOrders, slug: before.rows[0]!.slug }),
      ],
    );
    await client.query('COMMIT');
    return { updated: true, changed: true, accepts_network_orders: acceptsNetworkOrders };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface SetModernPanelResult {
  updated: boolean;
  changed?: boolean;
  reason?: 'not_found';
  modern_panel_enabled?: boolean;
}

/** Libera o painel moderno por unidade, com rollback imediato e trilha. */
export async function setPartnerUnitModernPanel(
  environment: 'prod' | 'test',
  partnerUnitId: string,
  enabled: boolean,
  actorLabel: string,
  dbPool: Pool = defaultPool,
): Promise<SetModernPanelResult> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query<{ modern_panel_enabled: boolean; slug: string }>(
      `SELECT modern_panel_enabled,slug
         FROM network.partner_units
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL
        FOR UPDATE`,
      [partnerUnitId, environment],
    );
    if (before.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { updated: false, reason: 'not_found' };
    }
    const previous = before.rows[0]!.modern_panel_enabled;
    if (previous === enabled) {
      await client.query('COMMIT');
      return { updated: true, changed: false, modern_panel_enabled: enabled };
    }
    await client.query(
      `UPDATE network.partner_units
          SET modern_panel_enabled=$3
        WHERE id=$1 AND environment=$2`,
      [partnerUnitId, environment, enabled],
    );
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,
          payload_before,payload_after)
       VALUES ($1,'network','network.partner_units',$2,'partner_modern_panel_updated',$3,
               $4::jsonb,$5::jsonb)`,
      [
        environment, partnerUnitId, actorLabel,
        JSON.stringify({ modern_panel_enabled: previous }),
        JSON.stringify({ modern_panel_enabled: enabled, slug: before.rows[0]!.slug }),
      ],
    );
    await client.query('COMMIT');
    return { updated: true, changed: true, modern_panel_enabled: enabled };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface PartnerPanelCanaryHealth {
  modern_panel_enabled: boolean;
  total_events_24h: number;
  error_events_24h: number;
  last_event_at: string | null;
  last_error_at: string | null;
  p95_duration_ms: number | null;
}

/** Agregado técnico de 24h; a tabela não possui PII nem valores de negócio. */
export async function getPartnerPanelCanaryHealth(
  environment: 'prod' | 'test',
  partnerUnitId: string,
  dbPool: Pool = defaultPool,
): Promise<PartnerPanelCanaryHealth | null> {
  const result = await dbPool.query<PartnerPanelCanaryHealth>(
    `SELECT pu.modern_panel_enabled,
            count(e.id)::int AS total_events_24h,
            count(e.id) FILTER (WHERE e.outcome='error')::int AS error_events_24h,
            max(e.created_at)::text AS last_event_at,
            max(e.created_at) FILTER (WHERE e.outcome='error')::text AS last_error_at,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY e.duration_ms)
              FILTER (WHERE e.duration_ms IS NOT NULL)::int AS p95_duration_ms
       FROM network.partner_units pu
       LEFT JOIN ops.partner_panel_canary_events e
         ON e.environment=pu.environment AND e.partner_unit_id=pu.id
        AND e.created_at >= now() - interval '24 hours'
      WHERE pu.environment=$1 AND pu.id=$2 AND pu.deleted_at IS NULL
      GROUP BY pu.modern_panel_enabled`,
    [environment, partnerUnitId],
  );
  return result.rows[0] ?? null;
}

export interface SetPartnerCoverageResult {
  updated: boolean;
  changed?: boolean;
  reason?: 'not_found';
  municipios?: string[];
}

/**
 * Atualiza as cidades atendidas sem apagar a configuração de bairros das cidades
 * que continuam selecionadas. Cidade removida perde todas as linhas; cidade nova
 * entra como cobertura da cidade inteira.
 */
export async function setPartnerUnitCoverage(
  environment: 'prod' | 'test',
  partnerUnitId: string,
  municipalities: readonly string[],
  actorLabel: string,
  dbPool: Pool = defaultPool,
): Promise<SetPartnerCoverageResult> {
  const desiredKeys = [...new Set(municipalities.map(normalizeMunicipalityKey))].sort();
  const desiredNames = desiredKeys.map((key) => resolveNetworkMunicipality(key)?.name ?? key);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const unit = await client.query<{ unit_id: string; slug: string }>(
      `SELECT unit_id,slug
         FROM network.partner_units
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL
        FOR UPDATE`,
      [partnerUnitId, environment],
    );
    if (unit.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { updated: false, reason: 'not_found' };
    }

    const current = await client.query<{ municipio: string }>(
      `SELECT DISTINCT municipio
         FROM network.unit_coverage
        WHERE environment=$1 AND unit_id=$2
        ORDER BY municipio`,
      [environment, unit.rows[0]!.unit_id],
    );
    const previousKeys = current.rows.map((row) => row.municipio);
    const unchanged = previousKeys.length === desiredKeys.length
      && previousKeys.every((value, index) => value === desiredKeys[index]);
    if (unchanged) {
      await client.query('COMMIT');
      return { updated: true, changed: false, municipios: desiredNames };
    }

    await client.query(
      `DELETE FROM network.unit_coverage
        WHERE environment=$1 AND unit_id=$2
          AND NOT (municipio=ANY($3::text[]))`,
      [environment, unit.rows[0]!.unit_id, desiredKeys],
    );
    const previousSet = new Set(previousKeys);
    for (const municipality of desiredKeys) {
      if (previousSet.has(municipality)) continue;
      await client.query(
        `INSERT INTO network.unit_coverage
           (environment,unit_id,municipio,neighborhood_canonical,coverage_kind)
         VALUES ($1,$2,$3,NULL,'city')
         ON CONFLICT (environment,unit_id,municipio,coalesce(neighborhood_canonical,''))
         DO NOTHING`,
        [environment, unit.rows[0]!.unit_id, municipality],
      );
    }
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,
          payload_before,payload_after)
       VALUES ($1,'network','network.partner_units',$2,'partner_coverage_updated',$3,
               $4::jsonb,$5::jsonb)`,
      [
        environment,
        partnerUnitId,
        actorLabel,
        JSON.stringify({ municipios: previousKeys }),
        JSON.stringify({ municipios: desiredKeys, slug: unit.rows[0]!.slug }),
      ],
    );
    await client.query('COMMIT');
    return { updated: true, changed: true, municipios: desiredNames };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
