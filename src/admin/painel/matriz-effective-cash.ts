// A consulta usa o alias t. Uma correção posterior também ajusta o período do original.
export const EFFECTIVE_CASH_TRANSACTION_SQL = `(
  (t.reversal_of_transaction_id IS NULL OR t.metadata->>'correction_type' IS DISTINCT FROM 'entry_error')
  AND NOT EXISTS (
    SELECT 1 FROM finance.matriz_ledger_transactions correction
    WHERE correction.environment=t.environment AND correction.reversal_of_transaction_id=t.id
      AND correction.metadata->>'correction_type'='entry_error'
  )
)`;
