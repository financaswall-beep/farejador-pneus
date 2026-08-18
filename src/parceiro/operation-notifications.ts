import type { PartnerContext, PartnerPermissions } from './auth.js';
import { withPartnerContext } from './db.js';
import type { OperationSystemNotice } from '../operation/notifications.js';

interface StockNoticeRow {
  low_stock: number;
  pending_registrations: number;
  pending_counts: number;
}

interface DeliveryNoticeRow {
  failed: number;
  delayed: number;
}

interface FinanceNoticeRow {
  due_today: number;
  overdue: number;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Alertas operacionais mínimos, sempre escopados à unidade e às permissões. */
export async function getPartnerOperationNotifications(
  ctx: PartnerContext,
  permissions: PartnerPermissions,
): Promise<{ notifications: OperationSystemNotice[] }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const stockResult = permissions.estoque ? await client.query<StockNoticeRow>(
        `SELECT
           (SELECT count(*)::int FROM commerce.partner_stock_levels s
             WHERE s.environment=$1 AND s.unit_id=$2 AND s.deleted_at IS NULL
               AND s.is_tracked
               AND s.stock_status IN ('low_stock','out_of_stock','reserved')) AS low_stock,
           (SELECT count(*)::int FROM commerce.partner_item_registration_requests r
             WHERE r.environment=$1 AND r.unit_id=$2 AND r.status='pending') AS pending_registrations,
           (SELECT count(*)::int FROM commerce.partner_stock_count_requests r
             WHERE r.environment=$1 AND r.unit_id=$2 AND r.status='pending') AS pending_counts`,
        [ctx.environment, ctx.unitId],
      ) : null;
    const deliveryResult = permissions.entregas ? await client.query<DeliveryNoticeRow>(
        `SELECT
           count(*) FILTER (WHERE p.delivery_status='failed')::int AS failed,
           count(*) FILTER (
             WHERE p.delivery_status='dispatched'
               AND COALESCE(p.dispatched_at,p.created_at)<now()-interval '30 minutes'
           )::int AS delayed
           FROM commerce.partner_orders_full p
          WHERE p.environment=$1 AND p.unit_id=$2
            AND p.fulfillment_mode='delivery' AND p.status<>'cancelled'
            AND p.delivery_status IN ('failed','dispatched')`,
        [ctx.environment, ctx.unitId],
      ) : null;
    const financeResult = permissions.financeiro && ctx.role === 'owner' ? await client.query<FinanceNoticeRow>(
        `SELECT
           count(*) FILTER (
             WHERE p.due_date=(now() AT TIME ZONE 'America/Sao_Paulo')::date
           )::int AS due_today,
           count(*) FILTER (
             WHERE p.due_date<(now() AT TIME ZONE 'America/Sao_Paulo')::date
           )::int AS overdue
           FROM finance.partner_payables p
          WHERE p.environment=$1 AND p.unit_id=$2 AND p.deleted_at IS NULL
            AND p.status='open'`,
        [ctx.environment, ctx.unitId],
      ) : null;

    const notifications: OperationSystemNotice[] = [];
    const stock = stockResult?.rows[0];
    const deliveries = deliveryResult?.rows[0];
    const finance = financeResult?.rows[0];

    if (ctx.role === 'owner' && stock && stock.pending_counts + stock.pending_registrations > 0) {
      const pending = stock.pending_counts + stock.pending_registrations;
      notifications.push({
        id: 'partner-stock-approvals', kind: 'stock',
        title: countLabel(pending, 'solicitação aguarda', 'solicitações aguardam') + ' aprovação',
        description: 'Confira os cadastros e as contagens enviados pela equipe.',
        badge: 'Estoque', target: 'stock', priority: 'attention',
      });
    }
    if (stock && stock.low_stock > 0) {
      notifications.push({
        id: 'partner-stock-low', kind: 'stock',
        title: countLabel(stock.low_stock, 'produto está', 'produtos estão') + ' com estoque baixo',
        description: 'Veja quais itens precisam de reposição.',
        badge: 'Estoque', target: 'stock', priority: 'normal',
      });
    }
    if (deliveries && deliveries.failed > 0) {
      notifications.push({
        id: 'partner-deliveries-failed', kind: 'delivery',
        title: countLabel(deliveries.failed, 'entrega precisa', 'entregas precisam') + ' de atenção',
        description: 'Uma falha foi informada e precisa ser conferida.',
        badge: 'Entregas', target: 'deliveries', priority: 'attention',
      });
    }
    if (deliveries && deliveries.delayed > 0) {
      notifications.push({
        id: 'partner-deliveries-delayed', kind: 'delivery',
        title: countLabel(deliveries.delayed, 'entrega está', 'entregas estão') + ' em rota há mais de 30 min',
        description: 'Acompanhe o andamento com o entregador.',
        badge: 'Entregas', target: 'deliveries', priority: 'normal',
      });
    }
    if (finance && finance.overdue > 0) {
      notifications.push({
        id: 'partner-payables-overdue', kind: 'finance',
        title: countLabel(finance.overdue, 'conta vencida', 'contas vencidas'),
        description: 'Confira as saídas pendentes no Financeiro.',
        badge: 'Financeiro', target: 'finance', priority: 'attention',
      });
    } else if (finance && finance.due_today > 0) {
      notifications.push({
        id: 'partner-payables-today', kind: 'finance',
        title: countLabel(finance.due_today, 'conta vence', 'contas vencem') + ' hoje',
        description: 'Confira os pagamentos programados para hoje.',
        badge: 'Financeiro', target: 'finance', priority: 'normal',
      });
    }
    return { notifications };
  });
}
