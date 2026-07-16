import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

export async function hasMatrizSellerColumn(
  db: Queryable,
  table: 'orders' | 'wholesale_orders',
): Promise<boolean> {
  const result = await db.query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='commerce' AND table_name=$1
          AND column_name='seller_collaborator_id'
     ) AS ready`,
    [table],
  );
  return Boolean(result.rows[0]?.ready);
}

/**
 * A migration 0133 foi publicada junto da tela. Durante o intervalo entre
 * deploy do codigo e aplicacao da migration, Financeiro nao pode cair por
 * referenciar uma tabela ainda inexistente.
 */
export async function hasMatrizPayrollSchema(db: Queryable): Promise<boolean> {
  const result = await db.query<{ ready: boolean }>(
    `SELECT to_regclass('finance.matriz_payroll_items') IS NOT NULL
         AND to_regclass('finance.matriz_payroll_periods') IS NOT NULL
         AND to_regclass('finance.matriz_payroll_adjustments') IS NOT NULL
         AND to_regclass('network.matriz_collaborator_compensation') IS NOT NULL
         AND to_regclass('network.matriz_collaborator_commission_rules') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='commerce' AND table_name='orders'
              AND column_name='seller_collaborator_id'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='commerce' AND table_name='wholesale_orders'
              AND column_name='seller_collaborator_id'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='network' AND table_name='matriz_collaborator_compensation'
              AND column_name='id'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='network' AND table_name='matriz_collaborator_commission_rules'
              AND column_name='id'
         ) AS ready`,
  );
  return Boolean(result.rows[0]?.ready);
}
