import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizNotificacoes } from '../painel/queries-notificacoes.js';
import type { CaixaAuth } from './queries.js';
import type { OperationSystemNotice } from '../../operation/notifications.js';

function quantity(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Traduz o agregador real da Matriz para o contrato pequeno do aplicativo.
 * A resposta é filtrada pelos módulos da sessão antes de sair do servidor.
 */
export async function getMatrizOperationNotifications(
  auth: CaixaAuth,
  dbPool: Pool = defaultPool,
): Promise<{ notifications: OperationSystemNotice[] }> {
  const source = await getMatrizNotificacoes(env.FAREJADOR_ENV, dbPool);
  const notifications: OperationSystemNotice[] = [];

  if (auth.modules.entregas && source.entregas_falhadas.length > 0) {
    notifications.push({
      id: 'matrix-deliveries-failed',
      kind: 'delivery',
      title: quantity(source.entregas_falhadas.length, 'entrega precisa', 'entregas precisam') + ' de atenção',
      description: 'O entregador informou uma falha. Confira a rota.',
      badge: 'Entregas',
      target: 'deliveries',
      priority: 'attention',
    });
  }

  if (auth.modules.financeiro && source.fiado_vencido.count > 0) {
    notifications.push({
      id: 'matrix-receivables-overdue',
      kind: 'finance',
      title: quantity(source.fiado_vencido.count, 'recebimento vencido', 'recebimentos vencidos'),
      description: 'Existem valores de clientes aguardando cobrança.',
      badge: 'Financeiro',
      target: 'finance',
      priority: 'attention',
    });
  }

  if (auth.modules.financeiro && source.a_pagar_vencido.count > 0) {
    notifications.push({
      id: 'matrix-payables-overdue',
      kind: 'finance',
      title: quantity(source.a_pagar_vencido.count, 'conta vencida', 'contas vencidas'),
      description: 'Confira os pagamentos pendentes da Matriz.',
      badge: 'Financeiro',
      target: 'finance',
      priority: 'attention',
    });
  }

  if (auth.modules.estoque && source.galpao_repor.length > 0) {
    notifications.push({
      id: 'matrix-stock-low',
      kind: 'stock',
      title: quantity(source.galpao_repor.length, 'produto está', 'produtos estão') + ' com estoque baixo',
      description: 'Confira a reposição do galpão.',
      badge: 'Estoque',
      target: 'stock',
      priority: 'normal',
    });
  }

  return { notifications };
}
