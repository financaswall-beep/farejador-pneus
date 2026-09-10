import type { Pool } from 'pg';

export interface BotVisaoMapaRow {
  municipio: string;
  chamou: number;
  pediu: number;
  efetivou: number;
  faltou: number;
}

export interface BotVisaoRadarRow {
  medida: string;
  pedidos: number;
  fora_catalogo: number;
  sem_estoque_perto: number;
  galpao_qty: number | null;
}

export interface BotMedidaMunicipio {
  municipio: string;
  medida: string;
  consultas: number;
  galpao_qty: number | null;
}

// Somente leitura. A janela SQL é uma constante interna de getBotVisao.
// Uma conversa conta uma vez por medida; estoque é o saldo atual de todas as marcas.
export async function getBotMedidasMunicipio(
  db: Pool, environment: 'prod' | 'test', sinceSql: string,
): Promise<BotMedidaMunicipio[]> {
  const result = await db.query<BotMedidaMunicipio>(
    `WITH procura AS (
       SELECT l.municipio, upper(btrim(cf.fact_value #>> '{}')) AS medida,
              count(DISTINCT cf.conversation_id)::int AS consultas
       FROM analytics.conversation_facts cf
       JOIN analytics.v_bot_demand_location l
         ON l.environment = cf.environment AND l.conversation_id = cf.conversation_id
       WHERE cf.environment = $1 AND cf.fact_key = 'medida_consultada'
         AND cf.superseded_by IS NULL AND l.municipio IS NOT NULL
         AND jsonb_typeof(cf.fact_value) = 'string'
         AND btrim(cf.fact_value #>> '{}') <> ''
         AND COALESCE(cf.observed_at, cf.created_at) >=
             (${sinceSql}::timestamp AT TIME ZONE 'America/Sao_Paulo')
       GROUP BY 1, 2
     ), ranking AS (
       SELECT *, row_number() OVER (PARTITION BY municipio ORDER BY consultas DESC, medida) AS pos
       FROM procura
     ), estoque AS (
       SELECT upper(btrim(measure)) AS medida, sum(quantity_on_hand)::int AS galpao_qty
       FROM commerce.wholesale_stock
       WHERE environment = $1
       GROUP BY 1
     )
     SELECT r.municipio, r.medida, r.consultas, e.galpao_qty
     FROM ranking r LEFT JOIN estoque e USING (medida)
     WHERE r.pos <= 10
     ORDER BY r.municipio, r.pos`,
    [environment],
  );
  return result.rows;
}
