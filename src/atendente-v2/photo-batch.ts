import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Valida o conjunto antes de criar qualquer card; reutiliza o roteamento individual. */
export async function requestPhotoBatch(
  client: PoolClient, environment: Environment, args: Record<string, unknown>,
  requestOne: (args: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  const raw = args.product_ids;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2 || args.product_id != null
    || raw.some(id => typeof id !== 'string' || !UUID.test(id))) {
    return JSON.stringify({ status: 'precisa_produto', mensagem: 'Informe um ou dois UUIDs dos pneus escolhidos em product_ids, sem product_id.' });
  }
  const ids = [...new Set(raw.map(id => String(id).toLowerCase()))];
  const products = await client.query<{ id: string }>(
    'SELECT id FROM commerce.products WHERE environment=$1 AND id=ANY($2::uuid[])', [environment, ids]);
  if (products.rows.length !== ids.length) return JSON.stringify({ status: 'precisa_produto', mensagem: 'Um dos pneus não está no catálogo deste ambiente. Confira os produtos escolhidos.' });
  const { product_ids: _ids, ...singleArgs } = args;
  const results: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    results.push({ ...JSON.parse(await requestOne({ ...singleArgs, product_id: id })), product_id: id });
  }
  const requested = results.filter(row => row.status === 'foto_solicitada' || row.status === 'aguardando_parceiro').length;
  return JSON.stringify({ status: requested === ids.length ? 'fotos_solicitadas' : requested ? 'fotos_parciais' : 'fotos_nao_solicitadas',
    total_solicitado: requested, solicitacoes: results,
    orientacao: 'Confira cada solicitação. Confirme somente as fotos solicitadas; aguardando_parceiro depende do TENHO. Solicitação não significa foto enviada.' });
}
