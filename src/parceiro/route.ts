import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePartnerAuth, requireOwner, requireScreen, resolvePartnerPermissions, getPartnerContext, authenticatePartner, type PartnerAuthedRequest } from './auth.js';
import { isSessionToken } from './password.js';
import { rateLimitHit } from './rate-limit.js';

// Login/1º acesso: até 10 tentativas por IP+slug a cada 5 min (anti-brute-force).
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

// Etapa 4: encadeamento padrão pros endpoints SÓ-DONO. Pós-Fase 1 (Config), o uso
// fica RESERVADO ao CADEADO DURO: gestão de funcionários e TODOS os /configuracoes*.
// Aqui requireOwner é CRU (funcionário sempre 403; nunca liberável por permissão).
const ownerOnly = [requirePartnerAuth, requireOwner];

// Fase 1 (Config/permissões): a tela Financeiro vira liberável ao funcionário pelo
// dono. As rotas de dinheiro (resumo já usa requireScreen('resumo')) passam de
// ownerOnly → requireScreen('financeiro'). Sem linha de permissão = OFF pro
// funcionário = comportamento de hoje; pro owner, requireScreen passa sempre.
const financeiroScreen = [requirePartnerAuth, requireScreen('financeiro')];
import {
  cancelPartnerSale,
  cancelPartnerPayable,
  cancelPartnerReceivable,
  DeliveryAlreadyFinalizedError,
  deletePartnerPurchase,
  deletePartnerStock,
  deletePartnerExpense,
  createPartnerCustomer,
  DuplicateExpenseError,
  InstallmentsNotAllowedError,
  InstallmentsTooSmallError,
  PaidPurchaseLockedError,
  PartialStockReversalError,
  StockBelowReservedError,
  StockReservedCannotDeleteError,
  getPartnerChatConversations,
  getPartnerChatMessages,
  getPartnerChatCustomer,
  sendPartnerChatMessage,
  markPartnerChatRead,
  linkPartnerChatCustomer,
  getPartnerCompras,
  getPartnerCustomers,
  getPartnerDespesas,
  getPartnerEstoque,
  getPartnerPayables,
  getPartnerProdutos,
  getPartnerReceivables,
  searchPartnerCatalog,
  searchPartnerCustomers,
  getPartnerFluxoCaixa,
  getPartnerResumo,
  getPartnerVendas,
  registerPartnerExpense,
  registerPartnerPayable,
  registerPartnerPurchase,
  registerPartnerReceivable,
  registerPartnerSale,
  settlePartnerPayable,
  settlePartnerReceivable,
  settlePartnerReceivableInstallment,
  updatePartnerCustomer,
  deletePartnerCustomer,
  updatePartnerPayable,
  updatePartnerReceivable,
  updatePartnerDeliveryStatus,
  upsertPartnerStock,
  createPartnerFuncionario,
  resetPartnerFuncionarioPassword,
  listPartnerFuncionarios,
  revokePartnerFuncionario,
  authenticatePartnerLogin,
  setOwnPartnerCredentials,
  revokePartnerSession,
  PartnerUsernameConflictError,
  PartnerCredentialsAlreadySetError,
  getPartnerConfiguracoes,
  updatePartnerLoja,
  updatePartnerAtendimento,
  updatePartnerArea,
  searchPartnerBairros,
  upsertPartnerPermissions,
  type PartnerServiceMode,
} from './queries.js';
import { env } from '../shared/config/env.js';
import { subscribePartnerChat, type PartnerChatEvent } from '../normalization/partner-chat.notify.js';

const publicDir = path.join(process.cwd(), 'parceiro', 'public');

// Extrai o bearer cru (Authorization: Bearer … ou x-partner-token). Usado pra
// distinguir token de sessão (ps_) de token de acesso cru no set-credentials/logout.
function bearerFrom(request: { headers: Record<string, unknown> }): string {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const x = request.headers['x-partner-token'];
  return typeof x === 'string' ? x.trim() : '';
}

const paramsSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
});

const expenseParamsSchema = paramsSchema.extend({
  expenseId: z.string().uuid(),
});

const saleParamsSchema = paramsSchema.extend({
  orderId: z.string().uuid(),
});

const stockParamsSchema = paramsSchema.extend({
  stockId: z.string().uuid(),
});

const deliverySchema = z.object({
  delivery_status: z.enum(['pending', 'dispatched', 'delivered', 'failed']),
  delivery_courier: z.string().max(120).nullable().optional(),
  // Metodo recebido na entrega (COD). So tem efeito quando delivery_status='delivered'.
  payment_method: z.string().max(80).nullable().optional(),
});

const purchaseParamsSchema = paramsSchema.extend({
  purchaseId: z.string().uuid(),
});

const payableParamsSchema = paramsSchema.extend({
  payableId: z.string().uuid(),
});

const receivableParamsSchema = paramsSchema.extend({
  receivableId: z.string().uuid(),
});

const receivableInstallmentParamsSchema = paramsSchema.extend({
  receivableId: z.string().uuid(),
  installmentId: z.string().uuid(),
});

// Venda local do parceiro: cada item aponta direto pro estoque local do parceiro
// (partner_stock_levels.id), não pra commerce.products. Decisão "silo isolado" 2026-05-19.
const orderItemSchema = z.object({
  partner_stock_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  discount_amount: z.number().nonnegative().optional(),
});

const saleSchema = z.object({
  customer_id: z.string().uuid().nullable().optional(),
  customer_name: z.string().min(1).max(200).nullable().optional(),
  customer_phone: z.string().min(1).max(40).nullable().optional(),
  customer_cpf: z.string().min(11).max(14).nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  payment_status: z.enum(['received', 'receivable']).nullable().optional(),
  receivable_due_date: z.string().date().nullable().optional(),
  receivable_installments: z.number().int().min(1).max(36).nullable().optional(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  received_amount: z.number().nonnegative().nullable().optional(),
  discount_amount: z.number().nonnegative().nullable().optional(),
  freight_amount: z.number().nonnegative().nullable().optional(),
  source_tag: z.enum(['porta', '2w', 'walkin_balcao', 'walkin_telefone', 'outro']).optional(),
  idempotency_key: z.string().min(8),
}).refine(
  // S6 da auditoria 2026-05-21: pedido de entrega exige endereco.
  (data) => data.fulfillment_mode !== 'delivery' || (data.delivery_address && data.delivery_address.trim().length > 0),
  {
    message: 'delivery_address obrigatorio quando fulfillment_mode=delivery',
    path: ['delivery_address'],
  },
).refine(
  // COD (0069): pedido de entrega "a receber" nao tem vencimento — o dinheiro vem
  // na hora da entrega. So exige due_date pra "a receber" de retirada (pickup).
  (data) => data.payment_status !== 'receivable'
    || data.fulfillment_mode === 'delivery'
    || (data.receivable_due_date && data.receivable_due_date.trim().length > 0),
  {
    message: 'receivable_due_date obrigatorio quando payment_status=receivable',
    path: ['receivable_due_date'],
  },
);

const stockSchema = z.object({
  stock_id: z.string().uuid().nullable().optional(),
  product_id: z.string().uuid().nullable().optional(),
  local_sku: z.string().max(80).nullable().optional(),
  item_name: z.string().min(1).max(240),
  // Tipo do item (migration 0067): pneu | insumo (camara, bico) | servico (mao de obra).
  item_type: z.enum(['pneu', 'insumo', 'servico']).default('pneu'),
  tire_size: z.string().max(80).nullable().optional(),
  // Dimensões do pneu (migration 0038). Frontend captura os 3 separados,
  // banco persiste pra busca indexada (commerce.tire_specs ja segue esse padrão).
  tire_width_mm: z.number().int().min(1).max(999).nullable().optional(),
  tire_aspect_ratio: z.number().int().min(1).max(999).nullable().optional(),
  tire_rim_diameter: z.number().int().min(1).max(30).nullable().optional(),
  brand: z.string().max(120).nullable().optional(),
  supplier_name: z.string().max(160).nullable().optional(),
  quantity_on_hand: z.number().int().nonnegative().nullable().optional(),
  minimum_quantity: z.number().int().nonnegative().nullable().optional(),
  average_cost: z.number().nonnegative().nullable().optional(),
  sale_price: z.number().nonnegative().nullable().optional(),
  // Campos do refit da tela de estoque (migration 0073).
  tire_condition: z.string().max(40).nullable().optional(),
  shelf_location: z.string().max(60).nullable().optional(),
  // Posição do pneu em coluna própria (migration 0075) — antes vivia em supplier_name.
  tire_position: z.string().max(40).nullable().optional(),
  is_tracked: z.boolean().default(true),
});

const customerSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(40).nullable().optional(),
  cpf: z.string().min(11).max(14).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  address_street: z.string().max(240).nullable().optional(),
  address_number: z.string().max(40).nullable().optional(),
  address_neighborhood: z.string().max(160).nullable().optional(),
  address_city: z.string().max(160).nullable().optional(),
  is_vip: z.boolean().nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
});

const customerSearchSchema = z.object({
  q: z.string().min(1).max(120),
});

const customerIdParamsSchema = paramsSchema.extend({
  customerId: z.string().uuid(),
});

const chatConversationParamsSchema = paramsSchema.extend({
  conversationId: z.string().uuid(),
});

// Etapa 4c: criar/revogar login de funcionário
// P1: credenciais de login. Usuário 3-60 (letras/números/. _ -); senha 6-200.
const usernameField = z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'usuario_invalido');
const passwordField = z.string().min(6).max(200);

const funcionarioSchema = z.object({
  label: z.string().trim().max(120).nullable().optional(),
  username: usernameField,
  password: passwordField,
});
const funcionarioParamsSchema = paramsSchema.extend({
  tokenId: z.string().uuid(),
});
const resetSenhaSchema = z.object({
  password: passwordField,
});

// Login por usuário+senha (público — é a porta de entrada).
const loginSchema = z.object({
  username: usernameField,
  password: passwordField,
});
// Primeiro acesso do dono: define o próprio usuário+senha (autenticado pelo token cru).
const setCredentialsSchema = z.object({
  username: usernameField,
  password: passwordField,
});

// ─── Configurações da Loja (Fase 1) ───
// Dados da loja: nome de exibição obrigatório; endereço estruturado + horário (texto livre).
const configLojaSchema = z.object({
  display_name: z.string().trim().min(1).max(200),
  address_street: z.string().trim().max(240).nullable().optional(),
  address_number: z.string().trim().max(40).nullable().optional(),
  address_neighborhood: z.string().trim().max(160).nullable().optional(),
  address_city: z.string().trim().max(160).nullable().optional(),
  address_complement: z.string().trim().max(240).nullable().optional(),
  cep: z.string().trim().max(20).nullable().optional(),
  opening_hours_text: z.string().trim().max(500).nullable().optional(),
});

// Atendimento: 2 booleans (arbitragem B). Pelo menos um obrigatório → senão 400.
const configAtendimentoSchema = z.object({
  faz_entrega: z.boolean(),
  tem_retirada: z.boolean(),
}).refine((d) => d.faz_entrega || d.tem_retirada, {
  message: 'Marque pelo menos uma opção (entrega ou retirada).',
  path: ['faz_entrega'],
});

// Área de entrega: cidade inteira vs bairros específicos (Fase 1 = declarativo).
const configAreaSchema = z.object({
  municipio: z.string().trim().min(1).max(160),
  city_wide: z.boolean(),
  neighborhoods: z.array(z.string().trim().min(1).max(160)).max(200).optional(),
}).refine((d) => d.city_wide || (Array.isArray(d.neighborhoods) && d.neighborhoods.length > 0), {
  message: 'Liste ao menos um bairro quando não for a cidade inteira.',
  path: ['neighborhoods'],
});

// Permissões: as 8 telas. 'config' NÃO está aqui (cadeado duro) — e mesmo se vier
// no corpo, a query (upsertPartnerPermissions) ignora qualquer chave fora da allowlist.
const configPermissoesSchema = z.object({
  vendas: z.boolean().optional(),
  estoque: z.boolean().optional(),
  pedidos: z.boolean().optional(),
  clientes: z.boolean().optional(),
  entregas: z.boolean().optional(),
  batepapo: z.boolean().optional(),
  resumo: z.boolean().optional(),
  financeiro: z.boolean().optional(),
}).passthrough(); // tolera chaves extras no corpo; a allowlist do servidor as descarta.

const bairrosQuerySchema = z.object({
  municipio: z.string().trim().max(160).optional(),
  q: z.string().trim().max(160).optional(),
});

const chatSendBodySchema = z.object({
  content: z.string().trim().min(1).max(4096),
  client_token: z.string().trim().min(1).max(128),
});

const chatLinkCustomerBodySchema = z.object({
  customer_id: z.string().uuid(),
});

const purchaseSchema = z.object({
  supplier_name: z.string().max(160).nullable().optional(),
  purchased_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  payment_status: z.enum(['paid_now', 'payable']).nullable().optional(),
  payable_due_date: z.string().date().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
  items: z.array(z.object({
    product_id: z.string().uuid().nullable().optional(),
    item_name: z.string().min(1).max(240),
    tire_size: z.string().max(80).nullable().optional(),
    tire_width_mm: z.number().int().min(1).max(999).nullable().optional(),
    tire_aspect_ratio: z.number().int().min(1).max(999).nullable().optional(),
    tire_rim_diameter: z.number().int().min(1).max(30).nullable().optional(),
    brand: z.string().max(120).nullable().optional(),
    quantity: z.number().int().positive(),
    unit_cost: z.number().nonnegative(),
    sale_price: z.number().nonnegative().nullable().optional(),
  })).min(1),
}).refine(
  (data) => data.payment_status !== 'payable' || (data.payable_due_date && data.payable_due_date.trim().length > 0),
  {
    message: 'payable_due_date obrigatorio quando payment_status=payable',
    path: ['payable_due_date'],
  },
);

const expenseSchema = z.object({
  expense_date: z.string().date().nullable().optional(),
  category: z.enum(['employee_payment', 'rent', 'utilities', 'maintenance', 'delivery', 'tax', 'supplier_payment', 'other']),
  description: z.string().min(1).max(300),
  amount: z.number().nonnegative(),
  payment_method: z.string().max(80).nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
});

const payableSchema = z.object({
  counterparty_name: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(300),
  category: z.enum(['supplier', 'employee', 'rent', 'utilities', 'tax', 'maintenance', 'other']).nullable().optional(),
  amount: z.number().nonnegative(),
  due_date: z.string().date().nullable().optional(),
  status: z.enum(['open', 'paid']).nullable().optional(),
  paid_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
  force_duplicate: z.boolean().optional(),
});

const payableUpdateSchema = payableSchema
  .omit({
    status: true,
    paid_at: true,
    payment_method: true,
    idempotency_key: true,
    force_duplicate: true,
  })
  .refine((data) => !!data.due_date, {
    message: 'due_date obrigatorio para conta a pagar em aberto',
    path: ['due_date'],
  });

const receivableSchema = z.object({
  customer_id: z.string().uuid().nullable().optional(),
  customer_name: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(300),
  source_tag: z.enum(['porta', '2w', 'walkin_balcao', 'walkin_telefone', 'outro']).nullable().optional(),
  amount: z.number().nonnegative(),
  due_date: z.string().date().nullable().optional(),
  status: z.enum(['open', 'received']).nullable().optional(),
  received_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
});

const receivableUpdateSchema = receivableSchema
  .omit({
    status: true,
    received_at: true,
    payment_method: true,
    idempotency_key: true,
  })
  .refine((data) => !!data.due_date, {
    message: 'due_date obrigatorio para conta a receber em aberto',
    path: ['due_date'],
  });

const settlePayableSchema = z.object({
  paid_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  force_duplicate: z.boolean().optional(),
});

const settleReceivableSchema = z.object({
  received_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
});

async function sendStatic(reply: FastifyReply, file: string, type: string) {
  const content = await readFile(path.join(publicDir, file));
  return reply
    .header('Content-Type', type)
    .header('Cache-Control', 'no-store')
    .send(content);
}

function validateSlug(request: PartnerAuthedRequest, reply: FastifyReply): boolean {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    void reply.status(404).send({ error: 'partner_not_found' });
    return false;
  }
  return true;
}

export async function registerParceiroRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/parceiro/:slug', async (request: PartnerAuthedRequest, reply) => {
    if (!validateSlug(request, reply)) return;
    const slug = (request.params as { slug: string }).slug;
    return reply.redirect(`/parceiro/${slug}/`);
  });

  fastify.get('/parceiro/:slug/', async (request: PartnerAuthedRequest, reply) => {
    if (!validateSlug(request, reply)) return;
    return sendStatic(reply, 'index.html', 'text/html; charset=utf-8');
  });

  fastify.get('/parceiro/:slug/app.js', async (_request, reply) => sendStatic(reply, 'app.js', 'text/javascript; charset=utf-8'));
  fastify.get('/parceiro/:slug/style.css', async (_request, reply) => sendStatic(reply, 'style.css', 'text/css; charset=utf-8'));

  // Assets estáticos (logo, ícones de canal do chat, fundo). Genérico + seguro:
  // basename evita path traversal; só extensões de imagem conhecidas são servidas.
  const assetContentTypes: Record<string, string> = {
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  fastify.get('/parceiro/:slug/assets/:asset', async (request: PartnerAuthedRequest, reply) => {
    const asset = path.basename(String((request.params as { asset?: string }).asset || ''));
    const type = assetContentTypes[path.extname(asset).toLowerCase()];
    if (!type) return reply.status(404).send({ error: 'asset_not_found' });
    try {
      return await sendStatic(reply, path.join('assets', asset), type);
    } catch {
      return reply.status(404).send({ error: 'asset_not_found' });
    }
  });

  // P1 — Login por usuário+senha (PÚBLICO; é a porta de entrada). Devolve um
  // token de SESSÃO que o front guarda e usa como Bearer. Resposta única pra
  // usuário inexistente e senha errada (não revela qual).
  fastify.post('/parceiro/:slug/api/login', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    // Slug malformado/inexistente devolve a MESMA resposta de credencial inválida
    // (não revela quais slugs existem).
    if (!params.success) return reply.status(401).send({ error: 'invalid_credentials' });
    if (rateLimitHit(`login:${request.ip}:${params.data.slug}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
      return reply.status(429).send({ error: 'too_many_attempts' });
    }
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(401).send({ error: 'invalid_credentials' });
    const result = await authenticatePartnerLogin(env.FAREJADOR_ENV, params.data.slug, parsed.data.username, parsed.data.password);
    if (!result) return reply.status(401).send({ error: 'invalid_credentials' });
    return reply.status(200).send(result);
  });

  // P1 — Primeiro acesso do DONO: autenticado pelo TOKEN cru que ele colou, define
  // o próprio usuário+senha e já recebe uma sessão. Posse do token (não-sessão)
  // permite re(definir) — é a recuperação do dono. Funcionário não usa isto.
  fastify.post('/parceiro/:slug/api/set-credentials', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const ctxSlug = (request.params as { slug?: string }).slug ?? '';
    if (rateLimitHit(`setcred:${request.ip}:${ctxSlug}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
      return reply.status(429).send({ error: 'too_many_attempts' });
    }
    const parsed = setCredentialsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.status(400).send({ error: `${issue?.path?.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
    }
    const allowOverwrite = !isSessionToken(bearerFrom(request));
    try {
      return reply.status(200).send(await setOwnPartnerCredentials(getPartnerContext(request), parsed.data.username, parsed.data.password, allowOverwrite));
    } catch (err) {
      if (err instanceof PartnerUsernameConflictError) return reply.status(409).send({ error: 'username_taken' });
      if (err instanceof PartnerCredentialsAlreadySetError) return reply.status(409).send({ error: 'credentials_already_set' });
      throw err;
    }
  });

  // P1 — Logout: revoga a sessão atual no servidor. Idempotente (token cru = no-op).
  fastify.post('/parceiro/:slug/api/logout', async (request, reply) => {
    const bearer = bearerFrom(request);
    if (bearer && isSessionToken(bearer)) {
      await revokePartnerSession(env.FAREJADOR_ENV, bearer);
    }
    return reply.status(200).send({ ok: true });
  });

  // Etapa 4: identidade do login atual. Liberado pros dois papéis — o front usa
  // o `role` + `permissions` pra montar o menu (canSee). É só apoio de UI; a trava
  // de verdade são os requireOwner/requireScreen nos endpoints.
  //
  // `permissions` é o mapa EFETIVO das 8 telas, resolvido NO SERVIDOR (gate §5.5):
  // owner → tudo true; funcionário → lê a tabela (ou defaults da Etapa 4 se não há
  // linha). Nunca aceito do cliente. Configurações NÃO está aqui (segue isOwner).
  fastify.get('/parceiro/:slug/api/me', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const ctx = getPartnerContext(request);
    const permissions = await resolvePartnerPermissions(ctx);
    return reply.status(200).send({
      role: ctx.role,
      slug: ctx.slug,
      partner_name: ctx.partnerName,
      unit_name: ctx.unitName,
      permissions,
    });
  });

  // Etapa 4c: o DONO gerencia logins de funcionário (criar/listar/revogar).
  // Tudo SÓ-DONO (ownerOnly) e escopado à própria unidade dentro das queries.
  fastify.get('/parceiro/:slug/api/funcionarios', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await listPartnerFuncionarios(getPartnerContext(request)) });
  });

  fastify.post('/parceiro/:slug/api/funcionarios', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = funcionarioSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.status(400).send({ error: `${issue?.path?.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
    }
    // O dono cria o login com usuário+senha; entrega ao funcionário. Sem token.
    try {
      return reply.status(200).send(
        await createPartnerFuncionario(getPartnerContext(request), parsed.data.label ?? null, parsed.data.username, parsed.data.password),
      );
    } catch (err) {
      if (err instanceof PartnerUsernameConflictError) {
        return reply.status(409).send({ error: 'username_taken' });
      }
      throw err;
    }
  });

  // Dono reseta a senha de um funcionário (o "esqueci a senha" — sem e-mail).
  fastify.post('/parceiro/:slug/api/funcionarios/:tokenId/reset-senha', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    const params = funcionarioParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'funcionario_not_found' });
    const body = resetSenhaSchema.safeParse(request.body ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      return reply.status(400).send({ error: `${issue?.path?.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
    }
    const result = await resetPartnerFuncionarioPassword(getPartnerContext(request), params.data.tokenId, body.data.password);
    if (!result.reset) return reply.status(404).send({ error: 'funcionario_not_found' });
    return reply.status(200).send(result);
  });

  fastify.delete('/parceiro/:slug/api/funcionarios/:tokenId', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = funcionarioParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'funcionario_not_found' });
    const result = await revokePartnerFuncionario(getPartnerContext(request), parsed.data.tokenId);
    if (!result.revoked) return reply.status(404).send({ error: 'funcionario_not_found' });
    return reply.status(200).send(result);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIGURAÇÕES DA LOJA (Fase 1). 🔒 CADEADO DURO: TODOS estes endpoints usam
  // requireOwner CRU (ownerOnly), NUNCA requireScreen. Configurações nunca é
  // liberável por permissão; funcionário leva 403 aqui (gate §5.2). Tudo escopado
  // por ctx.partnerUnitId/ctx.unitId nas queries (isolamento entre parceiros, §5.4).
  // ─────────────────────────────────────────────────────────────────────────

  // Lê TUDO: dados da loja + service_mode + cobertura/área + permissões efetivas.
  fastify.get('/parceiro/:slug/api/configuracoes', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send(await getPartnerConfiguracoes(getPartnerContext(request)));
  });

  // Dados da loja: nome de exibição, endereço estruturado, horário (texto).
  fastify.put('/parceiro/:slug/api/configuracoes/loja', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = configLojaSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.status(400).send({ error: `${issue?.path?.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
    }
    const result = await updatePartnerLoja(getPartnerContext(request), parsed.data);
    if (!result.updated) return reply.status(404).send({ error: 'unit_not_found' });
    return reply.status(200).send(result);
  });

  // Atendimento: 2 booleans → enum service_mode (arbitragem B). Pelo menos um (senão 400).
  fastify.put('/parceiro/:slug/api/configuracoes/atendimento', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = configAtendimentoSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.status(400).send({ error: `${issue?.path?.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
    }
    // Mapeia os 2 checkboxes pro enum: ambos→both, só entrega→delivery, só retirada→pickup.
    const { faz_entrega, tem_retirada } = parsed.data;
    const serviceMode: PartnerServiceMode = faz_entrega && tem_retirada
      ? 'both'
      : (faz_entrega ? 'delivery' : 'pickup');
    const result = await updatePartnerAtendimento(getPartnerContext(request), serviceMode);
    if (!result.updated) return reply.status(404).send({ error: 'unit_not_found' });
    return reply.status(200).send({ ...result, service_mode: serviceMode });
  });

  // Área de entrega: cidade inteira vs bairros específicos (Fase 1 = declarativo).
  fastify.put('/parceiro/:slug/api/configuracoes/area', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = configAreaSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.status(400).send({ error: `${issue?.path?.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await updatePartnerArea(getPartnerContext(request), {
        municipio: parsed.data.municipio,
        city_wide: parsed.data.city_wide,
        neighborhoods: parsed.data.neighborhoods ?? [],
      }));
    } catch (err) {
      if (err instanceof Error && (err.message === 'neighborhoods_required' || err.message === 'municipio_required')) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Busca de bairros pra a UI da área ("copa" → Copacabana). Read-only, owner-only.
  fastify.get('/parceiro/:slug/api/configuracoes/bairros', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = bairrosQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(200).send({ rows: [] });
    const ctx = getPartnerContext(request);
    const rows = await searchPartnerBairros(ctx.environment, parsed.data.municipio ?? null, parsed.data.q ?? '');
    return reply.status(200).send({ rows });
  });

  // Permissões de tela do funcionário (upsert 1:1). A allowlist do servidor
  // descarta qualquer chave fora das 8 telas (inclusive 'config') — gate §5.2.
  fastify.put('/parceiro/:slug/api/configuracoes/permissoes', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = configPermissoesSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.status(400).send({ error: `${issue?.path?.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
    }
    const permissions = await upsertPartnerPermissions(getPartnerContext(request), parsed.data);
    return reply.status(200).send({ permissions });
  });

  // SWAP de guard (ownerOnly → requireScreen): Resumo e Financeiro passam a depender
  // de permissão, pra o dono poder liberá-los ao funcionário (PLANO §2.3). Default
  // (sem linha de permissão) = Resumo/Financeiro OFF pro funcionário = comportamento
  // de hoje. Pro owner, requireScreen ≡ passa sempre (equivalente ao requireOwner).
  fastify.get('/parceiro/:slug/api/resumo', { preHandler: [requirePartnerAuth, requireScreen('resumo')] }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: [await getPartnerResumo(getPartnerContext(request))].filter(Boolean) });
  });

  // fluxo-caixa = projeção de caixa (tela Financeiro) → requireScreen('financeiro').
  fastify.get('/parceiro/:slug/api/fluxo-caixa', { preHandler: [requirePartnerAuth, requireScreen('financeiro')] }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: [await getPartnerFluxoCaixa(getPartnerContext(request))].filter(Boolean) });
  });

  // SWAP de guard (requirePartnerAuth → requireScreen): as telas operacionais
  // também ficam liberáveis/bloqueáveis pelo dono (PLANO §2.3 lista as 8). Default
  // (sem linha de permissão) = todas ON pro funcionário = comportamento de hoje.
  // Feeds de APOIO que servem VÁRIAS telas (produtos, catalogo/busca, clientes/buscar)
  // continuam só requirePartnerAuth: não são "telas" e o PDV/chat dependem deles
  // mesmo quando a tela-dona está desligada.
  fastify.get('/parceiro/:slug/api/vendas', { preHandler: [requirePartnerAuth, requireScreen('vendas')] }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerVendas(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/estoque', { preHandler: [requirePartnerAuth, requireScreen('estoque')] }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerEstoque(getPartnerContext(request)) });
  });

  // produtos: feed de catálogo do PDV/estoque — apoio, não tela. Segue requirePartnerAuth.
  fastify.get('/parceiro/:slug/api/produtos', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerProdutos(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/clientes', { preHandler: [requirePartnerAuth, requireScreen('clientes')] }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerCustomers(getPartnerContext(request)) });
  });

  // clientes/buscar: usado pelo PDV e pelo chat (apoio). Segue requirePartnerAuth.
  fastify.get('/parceiro/:slug/api/clientes/buscar', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = customerSearchSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(200).send({ rows: [] });
    return reply.status(200).send({ rows: await searchPartnerCustomers(getPartnerContext(request), parsed.data.q) });
  });

  fastify.post('/parceiro/:slug/api/clientes', { preHandler: [requirePartnerAuth, requireScreen('clientes')] }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = customerSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await createPartnerCustomer(getPartnerContext(request), parsed.data));
  });

  fastify.put('/parceiro/:slug/api/clientes/:customerId', { preHandler: [requirePartnerAuth, requireScreen('clientes')] }, async (request: PartnerAuthedRequest, reply) => {
    const params = customerIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_customer_id' });
    const parsed = customerSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await updatePartnerCustomer(getPartnerContext(request), params.data.customerId, parsed.data));
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'customer_not_found') return reply.status(404).send({ error: 'customer_not_found' });
        if (err.message === 'customer_phone_conflict') return reply.status(409).send({ error: 'customer_phone_conflict' });
        if (err.message === 'customer_cpf_conflict') return reply.status(409).send({ error: 'customer_cpf_conflict' });
        if (err.message === 'customer_name_required') return reply.status(400).send({ error: 'customer_name_required' });
      }
      throw err;
    }
  });

  fastify.delete('/parceiro/:slug/api/clientes/:customerId', { preHandler: [requirePartnerAuth, requireScreen('clientes')] }, async (request: PartnerAuthedRequest, reply) => {
    const params = customerIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_customer_id' });
    try {
      return reply.status(200).send(await deletePartnerCustomer(getPartnerContext(request), params.data.customerId));
    } catch (err) {
      if (err instanceof Error && err.message === 'customer_not_found') {
        return reply.status(404).send({ error: 'customer_not_found' });
      }
      throw err;
    }
  });

  // Chat unificado (Fatia 1.3) — leitura. Conversas e mensagens espelhadas
  // pelo fan-out do Chatwoot. Só leitura; o envio (POST) é Fatia 2.
  fastify.get('/parceiro/:slug/api/chat/conversations', { preHandler: [requirePartnerAuth, requireScreen('batepapo')] }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerChatConversations(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/chat/conversations/:conversationId/messages', { preHandler: [requirePartnerAuth, requireScreen('batepapo')] }, async (request: PartnerAuthedRequest, reply) => {
    const params = chatConversationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'conversation_not_found' });

    const rows = await getPartnerChatMessages(getPartnerContext(request), params.data.conversationId);
    if (rows === null) return reply.status(404).send({ error: 'conversation_not_found' });
    return reply.status(200).send({ rows });
  });

  // Fase 2a — cliente vinculado à conversa (por telefone) + métricas de compra.
  // Read-only. 404 se a conversa não existe/não é da unidade.
  fastify.get('/parceiro/:slug/api/chat/conversations/:conversationId/customer', { preHandler: [requirePartnerAuth, requireScreen('batepapo')] }, async (request: PartnerAuthedRequest, reply) => {
    const params = chatConversationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'conversation_not_found' });

    const data = await getPartnerChatCustomer(getPartnerContext(request), params.data.conversationId);
    if (data === null) return reply.status(404).send({ error: 'conversation_not_found' });
    return reply.status(200).send(data);
  });

  // Fatia 2 — envio. O parceiro responde o cliente; grava otimista + manda pro
  // Chatwoot (echo_id = client_token); o eco do webhook preenche o id depois.
  fastify.post('/parceiro/:slug/api/chat/conversations/:conversationId/send', { preHandler: [requirePartnerAuth, requireScreen('batepapo')] }, async (request: PartnerAuthedRequest, reply) => {
    const params = chatConversationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'conversation_not_found' });

    const body = chatSendBodySchema.safeParse(request.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return reply.status(400).send({ error: `${issue?.path.join('.')}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await sendPartnerChatMessage(
      getPartnerContext(request),
      params.data.conversationId,
      body.data.content,
      body.data.client_token,
    );
    if (result.status === 'not_found') return reply.status(404).send({ error: 'conversation_not_found' });
    if (result.status === 'send_failed') return reply.status(502).send({ error: 'send_failed' });
    return reply.status(200).send({ message: result.message });
  });

  // Marca a conversa como lida (zera unread_count) quando o parceiro a abre.
  fastify.post('/parceiro/:slug/api/chat/conversations/:conversationId/read', { preHandler: [requirePartnerAuth, requireScreen('batepapo')] }, async (request: PartnerAuthedRequest, reply) => {
    const params = chatConversationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'conversation_not_found' });

    const ok = await markPartnerChatRead(getPartnerContext(request), params.data.conversationId);
    if (!ok) return reply.status(404).send({ error: 'conversation_not_found' });
    return reply.status(200).send({ ok: true });
  });

  // Vincula um cliente à conversa de forma DURÁVEL (grava customer_id).
  // Resolve IG/FB, cujo identificador não é telefone — o vínculo persiste
  // em qualquer canal e sobrevive a reload/troca de conversa.
  fastify.post('/parceiro/:slug/api/chat/conversations/:conversationId/link-customer', { preHandler: [requirePartnerAuth, requireScreen('batepapo')] }, async (request: PartnerAuthedRequest, reply) => {
    const params = chatConversationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'conversation_not_found' });

    const body = chatLinkCustomerBodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'customer_id inválido' });

    const status = await linkPartnerChatCustomer(
      getPartnerContext(request),
      params.data.conversationId,
      body.data.customer_id,
    );
    if (status === 'conversation_not_found') return reply.status(404).send({ error: 'conversation_not_found' });
    if (status === 'customer_not_found') return reply.status(404).send({ error: 'customer_not_found' });
    return reply.status(200).send({ ok: true });
  });

  // Tempo real (Fatia 3): SSE que empurra um evento quando chega mensagem nova,
  // pra UI atualizar na hora sem depender do polling. EventSource NAO manda
  // header Authorization — por isso o token vem por query string e e validado
  // aqui do mesmo jeito (mesma function SECURITY DEFINER). O front cai no
  // polling se o SSE nao conectar.
  fastify.get('/parceiro/:slug/api/chat/stream', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { token } = request.query as { token?: string };
    if (!slug || !token) return reply.code(401).send({ error: 'partner_unauthorized' });
    const ctx = await authenticatePartner(slug.trim(), token);
    if (!ctx) return reply.code(401).send({ error: 'partner_unauthorized' });

    // Tela Bate-papo desligada pro funcionário → 403 (espelha requireScreen, que
    // este endpoint não usa por autenticar via query string). Owner passa sempre.
    if (ctx.role !== 'owner') {
      const permissions = await resolvePartnerPermissions(ctx);
      if (!permissions.batepapo) return reply.code(403).send({ error: 'partner_forbidden_screen', screen: 'batepapo' });
    }

    // Assume o controle da resposta crua (stream que nao fecha).
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // desliga buffering de proxy (nginx)
    });
    raw.write('retry: 3000\n\n');
    raw.write(': conectado\n\n');

    const send = (event: PartnerChatEvent): void => {
      raw.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = subscribePartnerChat(ctx.unitId, send);

    // Heartbeat: mantem a conexao viva atraves de proxies com idle timeout.
    const heartbeat = setInterval(() => {
      raw.write(': hb\n\n');
    }, 25000);

    // close/error podem disparar os dois; clearInterval e unsubscribe sao
    // idempotentes, entao chamar o cleanup duas vezes e inofensivo.
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });

  // Endpoint /catalogo (de VENDA) removido em 2026-05-19: a venda do parceiro é silo
  // isolado, aponta direto pra partner_stock_levels.id — isso CONTINUA assim.
  // P1 (Fundação Bot→Rede): busca read-only no catálogo central SÓ pra o parceiro
  // VINCULAR um item de estoque a um produto (preenche partner_stock_levels.product_id),
  // o ponteiro que o bot usa pra rotear a venda. Não toca o fluxo de venda.
  fastify.get('/parceiro/:slug/api/catalogo/busca', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const q = typeof (request.query as { q?: unknown })?.q === 'string' ? (request.query as { q: string }).q : '';
    return reply.status(200).send({ rows: await searchPartnerCatalog(getPartnerContext(request), q) });
  });

  fastify.get('/parceiro/:slug/api/despesas', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerDespesas(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/compras', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerCompras(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/contas-a-pagar', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerPayables(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/contas-a-receber', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerReceivables(getPartnerContext(request)) });
  });

  fastify.post('/parceiro/:slug/api/vendas', { preHandler: [requirePartnerAuth, requireScreen('vendas')] }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = saleSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await registerPartnerSale(getPartnerContext(request), parsed.data));
    } catch (err) {
      // Fix pos-Codex (#2): valor insuficiente para o numero de parcelas pedido
      // vira 400 com mensagem clara, nao 500.
      if (err instanceof InstallmentsTooSmallError) {
        return reply.status(400).send({
          error: err.code,
          message: err.message,
          total_cents: err.total_cents,
          installments: err.installments,
        });
      }
      if (err instanceof InstallmentsNotAllowedError) {
        return reply.status(400).send({
          error: err.code,
          message: 'Venda parcelada nao e suportada.',
        });
      }
      // BUG #2: erros de regra de negocio (estoque insuficiente, item inativado) viram
      // 422 com mensagem clara em vez de 500 internal_server_error.
      if (err instanceof Error && (
        err.message.includes('Estoque insuficiente') ||
        err.message.includes('Item de estoque') ||
        err.message.includes('quantity invalida') ||
        err.message.includes('unit_price invalido')
      )) {
        return reply.status(422).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.delete('/parceiro/:slug/api/vendas/:orderId', { preHandler: [requirePartnerAuth, requireScreen('vendas')] }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = saleParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'order_not_found' });

    const result = await cancelPartnerSale(getPartnerContext(request), parsed.data.orderId);
    if (!result.cancelled) return reply.status(404).send({ error: 'order_not_found' });
    return reply.status(200).send(result);
  });

  // Entrega: atualiza status (pendente/saiu/entregue) e entregador de uma venda delivery.
  fastify.post('/parceiro/:slug/api/entregas/:orderId', { preHandler: [requirePartnerAuth, requireScreen('entregas')] }, async (request: PartnerAuthedRequest, reply) => {
    const params = saleParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'order_not_found' });
    const parsed = deliverySchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await updatePartnerDeliveryStatus(getPartnerContext(request), params.data.orderId, parsed.data));
    } catch (err) {
      if (err instanceof DeliveryAlreadyFinalizedError) {
        return reply.status(409).send({ error: err.code, message: 'Esta entrega ja foi finalizada e nao pode ser reaberta.' });
      }
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      // 0076: deliver_partner_local_order falha alto se a reserva for insuficiente, ou
      // se a entrega já estiver finalizada (backstop do guard de estado no TS).
      if (err instanceof Error && err.message.includes('Reserva insuficiente')) {
        return reply.status(409).send({ error: 'reserva_insuficiente', message: err.message });
      }
      if (err instanceof Error && err.message.includes('Entrega ja finalizada')) {
        return reply.status(409).send({ error: 'delivery_already_finalized', message: 'Esta entrega ja foi finalizada.' });
      }
      throw err;
    }
  });

  fastify.post('/parceiro/:slug/api/estoque', { preHandler: [requirePartnerAuth, requireScreen('estoque')] }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = stockSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await upsertPartnerStock(getPartnerContext(request), parsed.data));
    } catch (err) {
      if (err instanceof StockBelowReservedError) {
        return reply.status(409).send({
          error: err.code,
          message: 'O saldo fisico nao pode ficar abaixo da quantidade reservada em entregas abertas.',
        });
      }
      throw err;
    }
  });

  fastify.delete('/parceiro/:slug/api/estoque/:stockId', { preHandler: [requirePartnerAuth, requireScreen('estoque')] }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = stockParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'stock_not_found' });

    try {
      const result = await deletePartnerStock(getPartnerContext(request), parsed.data.stockId);
      if (!result.deleted) return reply.status(404).send({ error: 'stock_not_found' });
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof StockReservedCannotDeleteError) {
        return reply.status(409).send({
          error: err.code,
          message: 'Este item tem quantidade reservada em entrega aberta e nao pode ser inativado agora.',
          stock_id: err.stock_id,
        });
      }
      throw err;
    }
  });

  fastify.post('/parceiro/:slug/api/compras', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = purchaseSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await registerPartnerPurchase(getPartnerContext(request), parsed.data));
  });

  fastify.delete('/parceiro/:slug/api/compras/:purchaseId', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = purchaseParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'purchase_not_found' });

    try {
      const result = await deletePartnerPurchase(getPartnerContext(request), parsed.data.purchaseId);
      if (!result.deleted) return reply.status(404).send({ error: 'purchase_not_found' });
      return reply.status(200).send(result);
    } catch (err) {
      // Fix pos-Codex (#3): compra com payable pago vinculado nao pode ser apagada
      if (err instanceof PaidPurchaseLockedError) {
        return reply.status(409).send({
          error: err.code,
          message: 'Esta compra ja foi paga. Para manter o financeiro correto, ela nao pode ser apagada. Faca ajuste manual/estorno em etapa futura.',
          purchase_id: err.purchase_id,
          paid_payable_id: err.paid_payable_id,
        });
      }
      // Fix pos-Codex (#4 mini-trava): se nao conseguiu estornar todos os itens, aborta
      if (err instanceof PartialStockReversalError) {
        return reply.status(409).send({
          error: err.code,
          message: 'Nao foi possivel localizar no estoque todos os itens desta compra para estornar. A compra nao foi apagada. Ajuste o estoque manualmente antes de tentar de novo.',
          failed_items: err.failed_items,
        });
      }
      throw err;
    }
  });

  fastify.post('/parceiro/:slug/api/despesas', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = expenseSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await registerPartnerExpense(getPartnerContext(request), parsed.data));
  });

  fastify.delete('/parceiro/:slug/api/despesas/:expenseId', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = expenseParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'expense_not_found' });

    const result = await deletePartnerExpense(getPartnerContext(request), parsed.data.expenseId);
    if (!result.deleted) return reply.status(404).send({ error: 'expense_not_found' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/contas-a-pagar', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = payableSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await registerPartnerPayable(getPartnerContext(request), parsed.data));
    } catch (err) {
      // status='paid' + force_duplicate=false pode disparar DuplicateExpenseError pelo helper interno
      if (err instanceof DuplicateExpenseError) {
        return reply.status(409).send({ error: err.code, duplicates: err.duplicates });
      }
      throw err;
    }
  });

  fastify.patch('/parceiro/:slug/api/contas-a-pagar/:payableId', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const params = payableParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'payable_not_found' });

    const parsed = payableUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await updatePartnerPayable(getPartnerContext(request), params.data.payableId, parsed.data);
    if (!result.updated) return reply.status(404).send({ error: 'payable_not_found_or_closed' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/contas-a-pagar/:payableId/pagar', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const params = payableParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'payable_not_found' });

    const parsed = settlePayableSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    try {
      const result = await settlePartnerPayable(getPartnerContext(request), params.data.payableId, parsed.data);
      if (!result.paid) return reply.status(404).send({ error: 'payable_not_found' });
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof DuplicateExpenseError) {
        return reply.status(409).send({ error: err.code, duplicates: err.duplicates });
      }
      throw err;
    }
  });

  fastify.delete('/parceiro/:slug/api/contas-a-pagar/:payableId', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = payableParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'payable_not_found' });

    const result = await cancelPartnerPayable(getPartnerContext(request), parsed.data.payableId);
    if (!result.cancelled) return reply.status(404).send({ error: 'payable_not_found' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/contas-a-receber', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = receivableSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await registerPartnerReceivable(getPartnerContext(request), parsed.data));
  });

  fastify.patch('/parceiro/:slug/api/contas-a-receber/:receivableId', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const params = receivableParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receivable_not_found' });

    const parsed = receivableUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await updatePartnerReceivable(getPartnerContext(request), params.data.receivableId, parsed.data);
    if (!result.updated) return reply.status(404).send({ error: 'receivable_not_found_or_closed' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/contas-a-receber/:receivableId/receber', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const params = receivableParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receivable_not_found' });

    const parsed = settleReceivableSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await settlePartnerReceivable(getPartnerContext(request), params.data.receivableId, parsed.data);
    if (!result.received) return reply.status(404).send({ error: 'receivable_not_found' });
    return reply.status(200).send(result);
  });

  fastify.delete('/parceiro/:slug/api/contas-a-receber/:receivableId', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = receivableParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'receivable_not_found' });

    const result = await cancelPartnerReceivable(getPartnerContext(request), parsed.data.receivableId);
    if (!result.cancelled) return reply.status(404).send({ error: 'receivable_not_found' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/contas-a-receber/:receivableId/parcelas/:installmentId/receber', { preHandler: financeiroScreen }, async (request: PartnerAuthedRequest, reply) => {
    const params = receivableInstallmentParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'installment_not_found' });

    const parsed = settleReceivableSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await settlePartnerReceivableInstallment(
      getPartnerContext(request),
      params.data.receivableId,
      params.data.installmentId,
      parsed.data,
    );
    if (!result.received) return reply.status(404).send({ error: 'installment_not_found' });
    return reply.status(200).send(result);
  });
}
