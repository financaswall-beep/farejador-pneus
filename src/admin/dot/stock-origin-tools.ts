import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { listStockOriginPendings, confirmStockOrigin } from '../painel/stock-origin.js';
import { stockOriginConfirmationSchema } from '../painel/stock-origin-inputs.js';
import { registerInventoryRead as read, registerInventoryWrite as write } from './inventory-registry.js';

const id = z.string().uuid();
const filter = z.object({
  numero_venda: z.string().trim().min(1).max(80).optional(),
  order_id: id.optional(),
  stock_id: id.optional(),
}).strict();

read('consultar_origens_pendentes', 'Localize a retirada de pneus pela venda, por exemplo 152 ou PED-0152. Se o dono pedir a fila, consulte sem filtros. A origem sugerida é uma previsão. Se houver par e avulso na mesma pilha, pergunte qual saiu antes de confirmar. Se houver várias vendas ou produtos possíveis, identifique o correto com o dono.',
  filter, async data => {
    const pendencias = await listStockOriginPendings(pool, env.FAREJADOR_ENV, {
      orderNumber: data.numero_venda, orderIds: data.order_id ? [data.order_id] : undefined, stockId: data.stock_id,
    });
    return { pendencias };
  });

write('stock', 'confirmar_origem_retirada', 'Confirme de qual pilha ou grupo saíram os pneus de uma venda já registrada. Copie os candidatos de consultar_origens_pendentes e distribua a quantidade conforme informado pelo dono. Para saldo sem pilha use o candidato correspondente. Se o dono não souber, deixe a origem pendente. Esta operação acerta a posição física sem lançar outra venda ou saída.',
  stockOriginConfirmationSchema, (db, data, actor) => confirmStockOrigin(db, env.FAREJADOR_ENV, data, actor), false,
  async (db, data) => {
    const [pending] = await listStockOriginPendings(db, env.FAREJADOR_ENV, { pendingId: data.pending_id });
    if (!pending) throw new Error('stock_origin_not_found');
    const origens = data.selections.map(row => {
      const origin = pending.candidates.find(candidate => candidate.candidate_id === row.candidate_id);
      if (!origin || row.quantity > origin.available) throw new Error('stock_origin_changed');
      return { pilha: origin.location_code, grupo: origin.group_id, conjunto: origin.matched_set,
        modelo: origin.model, quantidade: row.quantity };
    });
    if (data.selections.reduce((sum, row) => sum + row.quantity, 0) !== pending.quantity) {
      throw new Error('stock_origin_invalid');
    }
    return { venda: pending.order_number, produto: pending.product_name, origens };
  });
