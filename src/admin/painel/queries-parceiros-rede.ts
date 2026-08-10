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
