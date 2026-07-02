import type { PoolClient } from 'pg';

/** Baixa no estoque do galpão por medida (atacado Fase 2b). Agrega os itens da venda
 *  por medida e decrementa com CLAMP em 0 (GREATEST) — a venda NUNCA trava por estoque
 *  (medida não cadastrada simplesmente não baixa, 0 linhas afetadas). `enabled` é a flag
 *  (passada por quem chama, pra ser testável sem env). Deve rodar DENTRO da transação da
 *  venda pra ser atômico (rollback desfaz venda + baixa juntos). Módulo puro: não importa
 *  env nem db — só recebe o client da transação. */
export async function applyWholesaleStockDecrement(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: Array<{ measure: string; quantity: number }>,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const byMeasure = new Map<string, number>();
  for (const it of items) {
    const m = it.measure.trim();
    if (m) byMeasure.set(m, (byMeasure.get(m) ?? 0) + it.quantity);
  }
  for (const [measure, qty] of byMeasure) {
    await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = GREATEST(0, quantity_on_hand - $3)
        WHERE environment = $1 AND measure = $2`,
      [environment, measure, qty],
    );
  }
}

/** DEVOLUÇÃO ao galpão no CANCELAMENTO da venda (0116) — espelho exato da baixa acima:
 *  agrega por medida e soma de volta; medida não cadastrada é ignorada (igual a baixa
 *  ignorou). Assimetria honesta do clamp: se a venda baixou MENOS que o vendido (oversell
 *  confirmado clampa em 0), a devolução devolve o TOTAL vendido e pode inflar — caso raro,
 *  o dono confere no galpão físico; corrigir isso exige livro-razão (Camada 2, adiada).
 *  Mesmo contrato: roda DENTRO da transação do cancelamento; puro (sem env/db). */
export async function applyWholesaleStockReturn(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: Array<{ measure: string; quantity: number }>,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const byMeasure = new Map<string, number>();
  for (const it of items) {
    const m = it.measure.trim();
    if (m) byMeasure.set(m, (byMeasure.get(m) ?? 0) + it.quantity);
  }
  for (const [measure, qty] of byMeasure) {
    await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand + $3
        WHERE environment = $1 AND measure = $2`,
      [environment, measure, qty],
    );
  }
}
