import type { PoolClient } from 'pg';
import { matrizLedgerActor, postMatrizLedgerTransaction } from './matriz-ledger-posting.js';

export interface RetailTender {
  payment_method: string;
  cash_account: string;
  amount: number;
}

export async function settleSplitRetailTenders(client: PoolClient, environment: 'prod'|'test',
  orderId: string, revenueId: string, paidAt: string, actor: string|null, tenders: RetailTender[]) {
  for (const [index,tender] of tenders.entries()) {
    const amount = tender.amount;
    const id = await postMatrizLedgerTransaction(client, {
      environment, sourceType: index === 0 ? 'commerce.order.payment' : 'commerce.order.payment.'+(index+1),
      sourceId: orderId, kind: 'payment', amount, occurredAt: paidAt, cashAt: paidAt,
      createdBy: matrizLedgerActor(actor), description: 'Recebimento de venda no varejo',
      lines: [
        {account_code:'cash',account_class:'asset',side:'debit',amount},
        {account_code:'accounts_receivable',account_class:'asset',side:'credit',amount},
      ],
      metadata: {order_id:orderId,payment_method:tender.payment_method,cash_account:tender.cash_account},
    });
    await client.query('SELECT finance.record_matriz_ledger_payment($1::env_t,$2,$3,$4::timestamptz,$5,NULL)',
      [environment,revenueId,id,paidAt,matrizLedgerActor(actor)]);
  }
}
