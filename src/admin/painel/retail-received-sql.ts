// O alias o é o pedido da Matriz. Para uma venda a receber contam apenas
// movimentos reais de caixa vinculados à obrigação, líquidos dos estornos.
export const retailReceivedSql = `SELECT r.id AS receita_id, r.transaction_kind,
  CASE WHEN r.transaction_kind='sale_cash' THEN r.amount ELSE COALESCE((
    SELECT sum(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END)
      FROM finance.matriz_ledger_payments p JOIN finance.matriz_ledger_entries e
        ON e.environment=p.environment AND e.transaction_id=p.payment_transaction_id AND e.account_code='cash'
      WHERE p.environment=r.environment AND p.obligation_transaction_id=r.id
  ),0) END AS total
  FROM finance.matriz_ledger_transactions r WHERE r.environment=o.environment AND r.source_id=o.id::text
  AND r.source_type='commerce.order.revenue' AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions rev
    WHERE rev.environment=r.environment AND rev.reversal_of_transaction_id=r.id)`;
