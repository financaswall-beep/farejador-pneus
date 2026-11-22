import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DOT_SCOPE } from './config.js';
import { readGrantPermission } from './installment-reviews.js';
import { operationAllowed, operationReviewMode, requiresVoiceAuthorization, type OperationDomain, type OperationPermission } from './operation-policy.js';
import { withDotReadOnly } from './read-only.js';
import type { DotIdentity } from './token-store.js';

const securitySchemes = [{ type: 'oauth2', scopes: [DOT_SCOPE] }];
const noArguments = z.object({}).strict();

export const connectionPermissionsTool: Tool & { securitySchemes: typeof securitySchemes } = {
  name: 'consultar_permissoes_milly',
  description: 'Mostra quais operações estão liberadas nesta conexão da Milly e como o dono autoriza cada uma. Consulte antes de dizer que uma ferramenta de escrita está liberada.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  securitySchemes,
  _meta: { securitySchemes },
};

function permissionFor(permission: OperationPermission, domain: OperationDomain, tool?: string) {
  const habilitada = operationAllowed(permission, domain);
  return {
    habilitada,
    confirmacao: habilitada ? operationReviewMode(permission, domain, tool) ?? 'pedido_do_dono' : null,
    ...(requiresVoiceAuthorization(domain) ? { autorizacao_exigida: 'voz' } : {}),
  };
}

export async function invokeConnectionPermissions(identity: DotIdentity, args: unknown) {
  if (!noArguments.safeParse(args === undefined ? {} : args).success) {
    throw new McpError(ErrorCode.InvalidParams, 'Consulta sem parâmetros. A Matriz identifica a conexão automaticamente.');
  }

  try {
    const data = await withDotReadOnly(async db => {
      const permission = await readGrantPermission(db, identity.person_id, identity.grant_id);
      const vencimentos = permission.installment_reviews_enabled;
      return {
        escopo: 'conexao_atual',
        modo_configurado: permission.operation_confirmation ?? 'legacy',
        permissoes: {
          consultas: { habilitada: true },
          financeiro: permissionFor(permission, 'finance'),
          categorias_de_despesa: permissionFor(permission, 'finance', 'criar_categoria_despesa_matriz'),
          vencimentos: {
            habilitada: vencimentos,
            confirmacao: vencimentos ? (permission.installment_chat_confirmation ? 'conversa' : 'painel') : null,
          },
          publicador: permissionFor(permission, 'publisher'),
          estoque: permissionFor(permission, 'stock'),
          catalogo: permissionFor(permission, 'catalog'),
          cancelar_retirada: permissionFor(permission, 'pickup'),
          vendas_balcao: permissionFor(permission, 'retail'),
          rotas_realizadas: permissionFor(permission, 'route'),
          concluir_retirada: permissionFor(permission, 'pickup_completion'),
          receber_compra_em_transito: permissionFor(permission, 'purchase_receipt'),
        },
      };
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
  } catch {
    return { isError: true as const, content: [{ type: 'text' as const, text: 'Permissões desta conexão indisponíveis.' }] };
  }
}
