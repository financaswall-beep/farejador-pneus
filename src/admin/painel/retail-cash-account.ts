// t é a transação do livro. O lançamento original permanece imutável.
export const effectiveCashAccountSql = `COALESCE((SELECT a.payload_after->>'cash_account' FROM audit.events a
  WHERE a.environment=t.environment::text AND a.entity_id=t.id AND a.event_type='retail_receipt_account_corrected'
  ORDER BY a.created_at DESC,a.id DESC LIMIT 1),t.metadata->>'cash_account')`;
