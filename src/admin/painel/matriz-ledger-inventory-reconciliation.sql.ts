// Aplicar somente às transações finance.inventory_adjustment. A contrapartida
// credora aumenta o estoque e a devedora o reduz, inclusive em estornos.
export const INVENTORY_ADJUSTMENT_COUNTERPART_SQL = `CASE
  WHEN account_code IN ('opening_equity','owner_equity','inventory_gain','inventory_loss','inventory_internal_use')
    THEN CASE side WHEN 'credit' THEN amount ELSE -amount END
  ELSE 0 END`;
