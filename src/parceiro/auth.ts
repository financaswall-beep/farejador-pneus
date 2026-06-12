import type { FastifyReply, FastifyRequest } from 'fastify';
import { partnerPool } from './db.js';
// Pool admin (role 'postgres'): network.partner_unit_permissions NÃO tem GRANT pro
// pool restrito do portal (é tabela de AUTORIZAÇÃO, fora do alcance da role do app).
// A leitura do perfil do funcionário é sempre escopada por partner_unit_id na query.
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { isSessionToken } from './password.js';
import { logger } from '../shared/logger.js';

export type PartnerRole = 'owner' | 'funcionario';

// As 9 telas que o dono pode ligar/desligar pro funcionário (PLANO §2.3). NÃO
// existe 'config': Configurações é cadeado duro (nunca via permissão; trava no
// backend com requireOwner cru). Esta é a ALLOWLIST canônica — qualquer chave
// fora daqui é ignorada na escrita (defesa em profundidade, gate §5.2).
export const PARTNER_SCREENS = [
  'vendas', 'estoque', 'pedidos', 'clientes', 'entregas', 'retiradas', 'batepapo', 'resumo', 'financeiro',
] as const;
export type PartnerScreen = (typeof PARTNER_SCREENS)[number];

export type PartnerPermissions = Record<PartnerScreen, boolean>;

// Defaults da Etapa 4 (= comportamento de hoje): operacional ON; dinheiro OFF.
// LINHA AUSENTE em partner_unit_permissions ⇒ estes valores. Igual aos DEFAULTs
// das colunas da 0087, mas resolvidos no código pra não depender da linha existir.
const EMPLOYEE_DEFAULT_PERMISSIONS: PartnerPermissions = {
  vendas: true,
  estoque: true,
  pedidos: true,
  clientes: true,
  entregas: true,
  retiradas: true,
  batepapo: true,
  resumo: false,
  financeiro: false,
};

// Dono vê tudo, sempre — resolvido no código, NUNCA lendo tabela (gate §5.3/§5.5).
const OWNER_PERMISSIONS: PartnerPermissions = {
  vendas: true,
  estoque: true,
  pedidos: true,
  clientes: true,
  entregas: true,
  retiradas: true,
  batepapo: true,
  resumo: true,
  financeiro: true,
};

export interface PartnerContext {
  environment: 'prod' | 'test';
  partnerId: string;
  partnerUnitId: string;
  unitId: string;
  slug: string;
  partnerName: string;
  unitName: string;
  role: PartnerRole;
  // ID do login (linha em network.partner_access_tokens) deste contexto.
  // Usado pra amarrar credenciais (set-credentials no 1º acesso) ao login certo.
  tokenId: string;
}

export interface PartnerAuthedRequest extends FastifyRequest {
  partnerContext?: PartnerContext;
}

interface PartnerAuthRow {
  partner_unit_id: string;
  unit_id: string;
  partner_id: string;
  slug: string;
  partner_name: string;
  unit_name: string;
  token_id: string;
  role: string;
}

function extractBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Valida token de parceiro via function SECURITY DEFINER no banco.
 *
 * V2 da Etapa 5 (pos-Codex): a comparacao de hash e feita inteiramente
 * no banco via network.validate_partner_token. A role 'farejador_partner_app'
 * NAO tem SELECT direto em partner_access_tokens — so EXECUTE na function.
 *
 * Isso fecha o buraco "qualquer endpoint que leia partner_access_tokens vaza
 * o mapa da rede inteira", porque a tabela nao e mais lida em SELECT pelo
 * portal — so pela function controlada.
 */
/**
 * Valida slug+token e devolve o contexto do parceiro (ou null se invalido).
 * Reusavel fora do preHandler — ex.: SSE, onde o token vem por query string
 * porque EventSource nao manda header Authorization.
 */
function rowToContext(row: PartnerAuthRow): PartnerContext {
  // Fail-safe: qualquer valor inesperado de role é tratado como 'funcionario'
  // (o menos privilegiado). Só 'owner' explícito libera tudo.
  const role: PartnerRole = row.role === 'owner' ? 'owner' : 'funcionario';
  return {
    environment: env.FAREJADOR_ENV,
    partnerId: row.partner_id,
    partnerUnitId: row.partner_unit_id,
    unitId: row.unit_id,
    slug: row.slug,
    partnerName: row.partner_name,
    unitName: row.unit_name,
    role,
    tokenId: row.token_id,
  };
}

export async function authenticatePartnerToken(
  slug: string,
  token: string,
): Promise<PartnerContext | null> {
  // A function e SECURITY DEFINER, entao roda com privilegios do owner e nao
  // depende da policy aplicada a role 'farejador_partner_app'.
  const result = await partnerPool.query<PartnerAuthRow>(
    'SELECT * FROM network.validate_partner_token($1, $2, $3)',
    [env.FAREJADOR_ENV, slug, token],
  );

  if (result.rowCount !== 1) return null;
  return rowToContext(result.rows[0]!);
}

/**
 * Valida um TOKEN DE SESSÃO (emitido no login por usuário+senha). Mesma forma de
 * retorno de validate_partner_token, também SECURITY DEFINER (o pool restrito não
 * lê partner_sessions diretamente). Sessão expirada/revogada, ou login revogado,
 * devolve null.
 */
export async function authenticatePartnerSession(
  slug: string,
  sessionToken: string,
): Promise<PartnerContext | null> {
  const result = await partnerPool.query<PartnerAuthRow>(
    'SELECT * FROM network.validate_partner_session($1, $2, $3)',
    [env.FAREJADOR_ENV, slug, sessionToken],
  );

  if (result.rowCount !== 1) return null;
  return rowToContext(result.rows[0]!);
}

/**
 * Entrada única de autenticação: roteia pelo prefixo do bearer.
 *   - `ps_…`  → token de sessão (caminho novo, login por usuário+senha)
 *   - resto   → token de acesso legado (bootstrap do dono / fallback)
 * Um roundtrip só no banco em cada caso.
 */
export async function authenticatePartner(
  slug: string,
  bearer: string,
): Promise<PartnerContext | null> {
  return isSessionToken(bearer)
    ? authenticatePartnerSession(slug, bearer)
    : authenticatePartnerToken(slug, bearer);
}

export async function requirePartnerAuth(request: PartnerAuthedRequest, reply: FastifyReply): Promise<void> {
  const params = request.params as { slug?: string };
  const slug = params.slug?.trim();
  const token = extractBearerToken(request.headers.authorization) ?? (
    typeof request.headers['x-partner-token'] === 'string' ? request.headers['x-partner-token'] : null
  );

  if (!slug || !token) {
    void reply.status(401).send({ error: 'partner_unauthorized' });
    return;
  }

  const context = await authenticatePartner(slug, token);
  if (!context) {
    void reply.status(401).send({ error: 'partner_unauthorized' });
    return;
  }

  request.partnerContext = context;
}

export function getPartnerContext(request: PartnerAuthedRequest): PartnerContext {
  if (!request.partnerContext) {
    throw new Error('partner_context_missing');
  }
  return request.partnerContext;
}

/**
 * Guarda de autorização: só DONO (role='owner') passa. Funcionário leva 403.
 *
 * Etapa 4 (níveis dono/funcionário). Usar SEMPRE depois de requirePartnerAuth,
 * encadeado: { preHandler: [requirePartnerAuth, requireOwner] }. A trava real
 * é aqui no servidor — esconder a aba no front sem barrar o endpoint seria
 * teatro (funcionário poderia chamar a API direto).
 */
export async function requireOwner(request: PartnerAuthedRequest, reply: FastifyReply): Promise<void> {
  const context = request.partnerContext;
  if (!context) {
    void reply.status(401).send({ error: 'partner_unauthorized' });
    return;
  }
  if (context.role !== 'owner') {
    void reply.status(403).send({ error: 'partner_forbidden_owner_only' });
    return;
  }
}

/**
 * Resolve as permissões EFETIVAS de tela do contexto (PLANO §2.3, gate §5.5).
 *
 *   - owner        → todas as 9 telas true (resolvido no código, sem ler tabela).
 *   - funcionário  → POR PESSOA (0100): lê network.partner_token_permissions do
 *                    vínculo (token_id) → SENÃO partner_unit_permissions da loja
 *                    (0087, retrocompat) → SENÃO defaults da Etapa 4 (operacional ON,
 *                    Resumo/Financeiro OFF). SEM linha per-token = comportamento de hoje.
 *
 * 🔒 FAIL-SAFE (gate §5.3): qualquer erro ao LER o perfil → menor privilégio.
 * Aqui isso significa cair nos defaults da Etapa 4 (NÃO concede dinheiro;
 * Resumo/Financeiro ficam OFF). NUNCA "deixa passar" liberando telas.
 *
 * Sempre derivado no servidor; nunca aceito do cliente.
 */
type PermissionRow = {
  allow_vendas: boolean;
  allow_estoque: boolean;
  allow_pedidos: boolean;
  allow_clientes: boolean;
  allow_entregas: boolean;
  allow_retiradas: boolean;
  allow_batepapo: boolean;
  allow_resumo: boolean;
  allow_financeiro: boolean;
};

function permissionRowToPermissions(row: PermissionRow): PartnerPermissions {
  return {
    vendas: row.allow_vendas,
    estoque: row.allow_estoque,
    pedidos: row.allow_pedidos,
    clientes: row.allow_clientes,
    entregas: row.allow_entregas,
    retiradas: row.allow_retiradas,
    batepapo: row.allow_batepapo,
    resumo: row.allow_resumo,
    financeiro: row.allow_financeiro,
  };
}

export async function resolvePartnerPermissions(context: PartnerContext): Promise<PartnerPermissions> {
  if (context.role === 'owner') {
    return { ...OWNER_PERMISSIONS };
  }
  try {
    // (1) Perfil POR PESSOA (vínculo = token_id), 0100. Tem prioridade.
    const perToken = await pool.query<PermissionRow>(
      `SELECT allow_vendas, allow_estoque, allow_pedidos, allow_clientes,
              allow_entregas, allow_retiradas, allow_batepapo, allow_resumo, allow_financeiro
         FROM network.partner_token_permissions
        WHERE token_id = $1 AND environment = $2`,
      [context.tokenId, context.environment],
    );
    if (perToken.rows[0]) return permissionRowToPermissions(perToken.rows[0]);

    // (2) Retrocompat: perfil POR LOJA (0087). Vínculo ainda sem perfil próprio.
    const perUnit = await pool.query<PermissionRow>(
      `SELECT allow_vendas, allow_estoque, allow_pedidos, allow_clientes,
              allow_entregas, allow_retiradas, allow_batepapo, allow_resumo, allow_financeiro
         FROM network.partner_unit_permissions
        WHERE partner_unit_id = $1 AND environment = $2`,
      [context.partnerUnitId, context.environment],
    );
    if (perUnit.rows[0]) return permissionRowToPermissions(perUnit.rows[0]);

    // (3) Nenhum perfil ⇒ defaults da Etapa 4 (= comportamento de hoje).
    return { ...EMPLOYEE_DEFAULT_PERMISSIONS };
  } catch (err) {
    // Fail-safe: erro de leitura → menor privilégio (defaults; dinheiro NEGADO).
    logger.error({ err, tokenId: context.tokenId, partnerUnitId: context.partnerUnitId }, 'resolvePartnerPermissions_failed_denying_money');
    return { ...EMPLOYEE_DEFAULT_PERMISSIONS };
  }
}

/**
 * Guarda de autorização por TELA (PLANO §2.3). Vive ao lado de requireOwner, que
 * CONTINUA existindo e é o cadeado de Configurações/gestão de funcionários.
 *
 *   - owner        → passa sempre (dono vê tudo; resolvido no código).
 *   - funcionário  → passa só se a tela está ligada no perfil da unidade; tela
 *                    desligada → 403 DE VERDADE (não é só sumir o menu).
 *
 * 🔒 FAIL-SAFE (gate §5.3): erro ao ler o perfil → resolvePartnerPermissions já
 * devolve os defaults (Resumo/Financeiro OFF), então uma tela de dinheiro com
 * erro de leitura leva 403 — nunca "deixa passar".
 *
 * Usar SEMPRE depois de requirePartnerAuth, encadeado:
 *   { preHandler: [requirePartnerAuth, requireScreen('financeiro')] }.
 */
export function requireScreen(screen: PartnerScreen) {
  return async function requireScreenGuard(request: PartnerAuthedRequest, reply: FastifyReply): Promise<void> {
    const context = request.partnerContext;
    if (!context) {
      void reply.status(401).send({ error: 'partner_unauthorized' });
      return;
    }
    // Dono não lê tabela — passa direto (gate §5.3: nunca depende de I/O pra liberar).
    if (context.role === 'owner') return;

    const permissions = await resolvePartnerPermissions(context);
    if (!permissions[screen]) {
      void reply.status(403).send({ error: 'partner_forbidden_screen', screen });
      return;
    }
  };
}
