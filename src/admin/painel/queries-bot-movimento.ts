// Movimento do Bot: recorte diário ou semanal, sempre no dia comercial de
// São Paulo. Conversa usa started_at; pedido e faturamento usam created_at,
// ambos nas tabelas canônicas. Nenhum total paralelo é persistido.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export type BotMovementMode = 'daily' | 'weekly';

export interface BotMovementCards {
  conversas: number;
  fecharam: number;
  faturamento: number;
  ticket_medio: number | null;
}

export interface BotMovementPayload {
  range: {
    mode: BotMovementMode;
    selected_date: string;
    from: string;
    to: string;
    previous_from: string;
    previous_to: string;
    today: string;
  };
  cards: BotMovementCards;
  comparison: {
    conversas_pct: number | null;
    fecharam_delta: number;
    faturamento_pct: number | null;
  };
  horarios: Array<{ hora: number; conversas: number }>;
}

function addDays(value: string, amount: number): string {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function weekStart(value: string): string {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(value, -weekday);
}

function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function cardsFrom(row: Record<string, unknown> | undefined): BotMovementCards {
  const fecharam = Number(row?.fecharam || 0);
  const faturamento = Number(row?.faturamento || 0);
  const conversas = Number(row?.conversas || 0);
  return {
    conversas,
    fecharam,
    faturamento,
    ticket_medio: fecharam > 0 ? Math.round((faturamento / fecharam) * 100) / 100 : null,
  };
}

export async function getBotMovement(
  input: { mode: BotMovementMode; selectedDate: string; today: string },
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<BotMovementPayload> {
  const from = input.mode === 'weekly' ? weekStart(input.selectedDate) : input.selectedDate;
  const fullTo = input.mode === 'weekly' ? addDays(from, 6) : input.selectedDate;
  const to = fullTo > input.today ? input.today : fullTo;
  const comparisonOffset = input.mode === 'weekly' ? -7 : -1;
  const previousFrom = addDays(from, comparisonOffset);
  const previousTo = addDays(to, comparisonOffset);

  const totals = await dbPool.query(
    `WITH periods AS (
       SELECT 'current'::text AS bucket, $2::date AS from_date, $3::date AS to_date
       UNION ALL
       SELECT 'previous', $4::date, $5::date
     )
     SELECT periods.bucket,
            COALESCE(conversations.total, 0)::int AS conversas,
            COALESCE(orders.total, 0)::int AS fecharam,
            COALESCE(orders.revenue, 0)::numeric AS faturamento
       FROM periods
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS total
           FROM core.conversations conversation
          WHERE conversation.environment = $1
            AND conversation.deleted_at IS NULL
            AND conversation.started_at >= (periods.from_date::timestamp AT TIME ZONE 'America/Sao_Paulo')
            AND conversation.started_at < ((periods.to_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
       ) conversations ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS total, COALESCE(sum(an_order.total_amount), 0)::numeric AS revenue
           FROM commerce.orders an_order
          WHERE an_order.environment = $1
            AND an_order.source IN ('bot_promoted', 'chatwoot_com_bot')
            AND an_order.source_conversation_id IS NOT NULL
            AND an_order.status <> 'cancelled'
            AND an_order.created_at >= (periods.from_date::timestamp AT TIME ZONE 'America/Sao_Paulo')
            AND an_order.created_at < ((periods.to_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
       ) orders ON true`,
    [environment, from, to, previousFrom, previousTo],
  );
  const byBucket = Object.fromEntries(totals.rows.map((row) => [row.bucket, row]));
  const cards = cardsFrom(byBucket.current);
  const previous = cardsFrom(byBucket.previous);

  const hourly = await dbPool.query(
    `WITH hours AS (SELECT generate_series(0, 23)::int AS hora), counts AS (
       SELECT extract(hour FROM started_at AT TIME ZONE 'America/Sao_Paulo')::int AS hora,
              count(*)::int AS conversas
         FROM core.conversations
        WHERE environment = $1
          AND deleted_at IS NULL
          AND started_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND started_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        GROUP BY 1
     )
     SELECT hours.hora, COALESCE(counts.conversas, 0)::int AS conversas
       FROM hours LEFT JOIN counts USING (hora)
      ORDER BY hours.hora`,
    [environment, from, to],
  );

  return {
    range: {
      mode: input.mode,
      selected_date: input.selectedDate,
      from,
      to,
      previous_from: previousFrom,
      previous_to: previousTo,
      today: input.today,
    },
    cards,
    comparison: {
      conversas_pct: percentageChange(cards.conversas, previous.conversas),
      fecharam_delta: cards.fecharam - previous.fecharam,
      faturamento_pct: percentageChange(cards.faturamento, previous.faturamento),
    },
    horarios: hourly.rows.map((row) => ({
      hora: Number(row.hora),
      conversas: Number(row.conversas),
    })),
  };
}
