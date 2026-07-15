import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface ClientePainelRow {
  id: string;
  source: 'chatwoot' | 'balcao' | 'parceiro' | 'atacado';
  source_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  kind: 'pessoa_fisica' | 'borracharia' | 'parceiro' | 'nao_classificado';
  is_vip: boolean;
  origin: string;
  status: 'ativo' | 'inativo';
  purchases: number;
  total_spent: number;
  avg_ticket: number;
  gross_profit: number;
  last_item: string | null;
  first_purchase_at: string | null;
  last_purchase_at: string | null;
  last_interaction_at: string | null;
  lead_stage: string | null;
  lead_outcome: string | null;
  partner_id: string | null;
  partner_name: string | null;
}

export interface ClienteParceiroRow {
  partner_id: string;
  name: string;
  phone: string | null;
  document_number: string | null;
  status: string;
  commercial_model: string;
  linked_buyer_id: string | null;
  purchases: number;
  total_bought: number;
  last_purchase_at: string | null;
  created_at: string;
}

const normalizedKindSql = `CASE
  WHEN lower(COALESCE(lt.customer_type, '')) ~ 'borrach|empresa|frota|oficina' THEN 'borracharia'
  WHEN lower(COALESCE(lt.customer_type, '')) ~ 'pessoa|fisica|final' THEN 'pessoa_fisica'
  ELSE 'nao_classificado'
END`;

export async function getClientesPainel(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ rows: ClientePainelRow[]; partners: ClienteParceiroRow[] }> {
  const [chatwoot, balcao, parceiro, atacado, partners] = await Promise.all([
    dbPool.query<ClientePainelRow>(
      `WITH latest_type AS (
         SELECT DISTINCT ON (cv.contact_id) cv.contact_id, ac.value AS customer_type
           FROM core.conversations cv
           JOIN analytics.conversation_classifications ac
             ON ac.conversation_id = cv.id AND ac.environment = cv.environment
          WHERE cv.environment = $1 AND ac.dimension = 'customer_type'
          ORDER BY cv.contact_id, ac.created_at DESC
       ), latest_funnel AS (
         SELECT cv.contact_id,
                max(ac.value) FILTER (WHERE ac.dimension = 'stage_reached') AS stage,
                max(ac.value) FILTER (WHERE ac.dimension = 'final_outcome') AS outcome
           FROM core.conversations cv
           JOIN analytics.conversation_classifications ac
             ON ac.conversation_id = cv.id AND ac.environment = cv.environment
          WHERE cv.environment = $1 AND ac.dimension IN ('stage_reached', 'final_outcome')
          GROUP BY cv.contact_id
       )
       SELECT 'chatwoot:' || c.id AS id, 'chatwoot' AS source, c.id::text AS source_id,
              COALESCE(NULLIF(c.name, ''), 'Cliente sem nome') AS name,
              c.phone_e164 AS phone, c.email, ${normalizedKindSql} AS kind, false AS is_vip,
              COALESCE(NULLIF(c.channel_type, ''), 'Chatwoot') AS origin,
              CASE WHEN COALESCE(c.last_seen_at, c.updated_at) >= now() - interval '90 days' THEN 'ativo' ELSE 'inativo' END AS status,
              COALESCE(cp.total_orders, 0)::int AS purchases,
              COALESCE(cp.total_spent, 0)::float8 AS total_spent,
              COALESCE(cp.avg_ticket, 0)::float8 AS avg_ticket,
              COALESCE(fin.gross_profit, 0)::float8 AS gross_profit,
              last_product.label AS last_item,
              cp.first_order_at::text AS first_purchase_at, cp.last_order_at::text AS last_purchase_at,
              COALESCE(c.last_seen_at, c.updated_at)::text AS last_interaction_at,
              lf.stage AS lead_stage, lf.outcome AS lead_outcome,
              NULL::text AS partner_id, NULL::text AS partner_name
         FROM core.contacts c
         LEFT JOIN commerce.customer_profile cp ON cp.contact_id = c.id AND cp.environment = c.environment
         LEFT JOIN latest_type lt ON lt.contact_id = c.id
         LEFT JOIN latest_funnel lf ON lf.contact_id = c.id
         LEFT JOIN LATERAL (
           SELECT sum(((oi.unit_price - COALESCE(oi.matriz_unit_cost, oi.unit_price)) * oi.quantity) - oi.discount_amount) AS gross_profit
             FROM commerce.orders ox JOIN commerce.order_items oi ON oi.order_id = ox.id
            WHERE ox.contact_id = c.id AND ox.environment = c.environment AND ox.status <> 'cancelled'
         ) fin ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(ts.tire_size, p.product_name) AS label
             FROM commerce.orders ox
             JOIN commerce.order_items oi ON oi.order_id = ox.id
             JOIN commerce.products p ON p.id = oi.product_id
             LEFT JOIN commerce.tire_specs ts ON ts.product_id = p.id AND ts.environment = p.environment
            WHERE ox.contact_id = c.id AND ox.environment = c.environment AND ox.status <> 'cancelled'
            ORDER BY ox.created_at DESC, oi.created_at DESC LIMIT 1
         ) last_product ON true
        WHERE c.environment = $1 AND c.deleted_at IS NULL
        ORDER BY COALESCE(c.last_seen_at, c.updated_at) DESC
        LIMIT 500`,
      [environment],
    ),
    dbPool.query<ClientePainelRow>(
      `SELECT 'balcao:' || c.id AS id, 'balcao' AS source, c.id::text AS source_id,
              COALESCE(NULLIF(c.name, ''), 'Cliente sem nome') AS name, c.phone_e164 AS phone,
              c.email, 'nao_classificado' AS kind, false AS is_vip,
              CASE c.source WHEN 'walkin' THEN 'Balcão' WHEN 'chatwoot_manual' THEN 'Chatwoot manual' ELSE 'ERP' END AS origin,
              CASE WHEN COALESCE(max(o.created_at), c.updated_at) >= now() - interval '90 days' THEN 'ativo' ELSE 'inativo' END AS status,
              count(o.id) FILTER (WHERE o.status <> 'cancelled')::int AS purchases,
              COALESCE(sum(o.total_amount) FILTER (WHERE o.status <> 'cancelled'), 0)::float8 AS total_spent,
              COALESCE(avg(o.total_amount) FILTER (WHERE o.status <> 'cancelled'), 0)::float8 AS avg_ticket,
              COALESCE((SELECT sum(((oi.unit_price - COALESCE(oi.matriz_unit_cost, oi.unit_price)) * oi.quantity) - oi.discount_amount)
                          FROM commerce.orders ox JOIN commerce.order_items oi ON oi.order_id = ox.id
                         WHERE ox.customer_id = c.id AND ox.environment = c.environment AND ox.status <> 'cancelled'), 0)::float8 AS gross_profit,
              (SELECT COALESCE(ts.tire_size, p.product_name)
                 FROM commerce.orders ox JOIN commerce.order_items oi ON oi.order_id = ox.id
                 JOIN commerce.products p ON p.id = oi.product_id
                 LEFT JOIN commerce.tire_specs ts ON ts.product_id = p.id AND ts.environment = p.environment
                WHERE ox.customer_id = c.id AND ox.environment = c.environment AND ox.status <> 'cancelled'
                ORDER BY ox.created_at DESC, oi.created_at DESC LIMIT 1) AS last_item,
              min(o.created_at) FILTER (WHERE o.status <> 'cancelled')::text AS first_purchase_at,
              max(o.created_at) FILTER (WHERE o.status <> 'cancelled')::text AS last_purchase_at,
              COALESCE(max(o.created_at), c.updated_at)::text AS last_interaction_at,
              NULL::text AS lead_stage, NULL::text AS lead_outcome,
              NULL::text AS partner_id, NULL::text AS partner_name
         FROM commerce.customers c
         LEFT JOIN commerce.orders o ON o.customer_id = c.id AND o.environment = c.environment
        WHERE c.environment = $1 AND c.deleted_at IS NULL
        GROUP BY c.id
        ORDER BY COALESCE(max(o.created_at), c.updated_at) DESC
        LIMIT 500`,
      [environment],
    ),
    dbPool.query<ClientePainelRow>(
      `SELECT 'parceiro:' || pc.id AS id, 'parceiro' AS source, pc.id::text AS source_id,
              pc.name, pc.phone, NULL::text AS email,
              CASE WHEN pc.cpf IS NOT NULL THEN 'pessoa_fisica' ELSE 'nao_classificado' END AS kind,
              pc.is_vip, COALESCE(pu.display_name, 'Loja parceira') AS origin,
              CASE WHEN pc.updated_at >= now() - interval '90 days' THEN 'ativo' ELSE 'inativo' END AS status,
              count(po.id) FILTER (WHERE po.status <> 'cancelled')::int AS purchases,
              COALESCE(sum(po.total_amount) FILTER (WHERE po.status <> 'cancelled'), 0)::float8 AS total_spent,
              COALESCE(avg(po.total_amount) FILTER (WHERE po.status <> 'cancelled'), 0)::float8 AS avg_ticket,
              0::float8 AS gross_profit,
              (SELECT COALESCE(poi.tire_size, poi.item_name)
                 FROM commerce.partner_orders pox JOIN commerce.partner_order_items poi ON poi.order_id = pox.id
                WHERE pox.customer_id = pc.id AND pox.environment = pc.environment AND pox.status <> 'cancelled'
                ORDER BY pox.created_at DESC, poi.created_at DESC LIMIT 1) AS last_item,
              min(po.created_at) FILTER (WHERE po.status <> 'cancelled')::text AS first_purchase_at,
              max(po.created_at) FILTER (WHERE po.status <> 'cancelled')::text AS last_purchase_at,
              pc.updated_at::text AS last_interaction_at,
              NULL::text AS lead_stage, NULL::text AS lead_outcome,
              np.id::text AS partner_id, np.trade_name AS partner_name
         FROM commerce.partner_customers pc
         JOIN network.partner_units pu ON pu.unit_id = pc.unit_id AND pu.environment = pc.environment AND pu.deleted_at IS NULL
         JOIN network.partners np ON np.id = pu.partner_id AND np.environment = pc.environment AND np.deleted_at IS NULL
         LEFT JOIN commerce.partner_orders po ON po.customer_id = pc.id AND po.environment = pc.environment AND po.deleted_at IS NULL
        WHERE pc.environment = $1 AND pc.deleted_at IS NULL
        GROUP BY pc.id, pu.display_name, np.id, np.trade_name
        ORDER BY pc.updated_at DESC
        LIMIT 500`,
      [environment],
    ),
    dbPool.query<ClientePainelRow>(
      `SELECT 'atacado:' || s.buyer_id AS id, 'atacado' AS source, s.buyer_id::text AS source_id,
              s.name, s.phone, NULL::text AS email, 'borracharia' AS kind, false AS is_vip,
              CASE WHEN s.is_partner THEN 'Parceiro da rede' ELSE 'Atacado' END AS origin,
              CASE WHEN s.last_purchase_at IS NULL OR s.last_purchase_at >= now() - interval '90 days' THEN 'ativo' ELSE 'inativo' END AS status,
              s.orders_count::int AS purchases, s.total_bought::float8 AS total_spent,
              CASE WHEN s.orders_count > 0 THEN (s.total_bought / s.orders_count)::float8 ELSE 0 END AS avg_ticket,
              COALESCE((SELECT sum(woi.line_profit) FROM commerce.wholesale_orders wo
                         JOIN commerce.wholesale_order_items woi ON woi.order_id = wo.id
                        WHERE wo.buyer_id = s.buyer_id AND wo.environment = s.environment AND wo.status = 'confirmed'), 0)::float8 AS gross_profit,
              (SELECT woi.measure FROM commerce.wholesale_orders wo
                JOIN commerce.wholesale_order_items woi ON woi.order_id = wo.id
               WHERE wo.buyer_id = s.buyer_id AND wo.environment = s.environment AND wo.status = 'confirmed'
               ORDER BY wo.sold_at DESC, woi.created_at DESC LIMIT 1) AS last_item,
              NULL::text AS first_purchase_at, s.last_purchase_at::text AS last_purchase_at,
              COALESCE(s.last_purchase_at, wc.updated_at)::text AS last_interaction_at,
              NULL::text AS lead_stage, NULL::text AS lead_outcome,
              s.partner_id::text AS partner_id, np.trade_name AS partner_name
         FROM commerce.wholesale_buyer_summary s
         JOIN commerce.wholesale_customers wc ON wc.id = s.buyer_id
         LEFT JOIN network.partners np ON np.id = s.partner_id AND np.environment = s.environment
        WHERE s.environment = $1
        ORDER BY s.total_bought DESC
        LIMIT 500`,
      [environment],
    ),
    dbPool.query<ClienteParceiroRow>(
      `SELECT p.id::text AS partner_id, p.trade_name AS name, p.whatsapp_phone AS phone,
              p.document_number, p.status, p.commercial_model,
              s.buyer_id::text AS linked_buyer_id, COALESCE(s.orders_count, 0)::int AS purchases,
              COALESCE(s.total_bought, 0)::float8 AS total_bought,
              s.last_purchase_at::text AS last_purchase_at, p.created_at::text AS created_at
         FROM network.partners p
         LEFT JOIN commerce.wholesale_buyer_summary s
           ON s.partner_id = p.id AND s.environment = p.environment
        WHERE p.environment = $1 AND p.deleted_at IS NULL
        ORDER BY p.status = 'active' DESC, p.trade_name`,
      [environment],
    ),
  ]);

  return {
    rows: [...chatwoot.rows, ...balcao.rows, ...parceiro.rows, ...atacado.rows],
    partners: partners.rows,
  };
}
