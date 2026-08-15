import type { PartnerContext, PartnerPermissions } from './auth.js';
import { createPartnerFuncionario } from './queries.js';

export async function createPartnerOperationMember(ctx: PartnerContext, input: {
  name: string; username: string; password: string;
  role: 'vendedor' | 'estoque' | 'entregador';
}) {
  const permissions: PartnerPermissions = {
    vendas: input.role === 'vendedor', estoque: input.role === 'estoque',
    pedidos: false, clientes: false, entregas: input.role === 'entregador',
    retiradas: false, batepapo: false, resumo: false, financeiro: false,
  };
  return createPartnerFuncionario(
    ctx, input.name, input.username, input.password, permissions,
  );
}
