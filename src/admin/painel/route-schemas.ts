// Obra 300 (2026-07-05): mezanino da portaria da matriz — schemas zod + publicDir.
// VERBATIM das linhas 76-325 do route.ts pré-obra + prefixo 'export ' nas declarações
// de topo (transformação mecânica; o gerador prova a reversa). Porta: ./route.js.
import path from 'node:path';
import { z } from 'zod';

const idempotencyKeySchema = z.string().min(8).max(200);

export const resolveIntegrityOperationSchema = z.object({
  domain: z.enum([
    'wholesale_sale.create',
    'wholesale_purchase.create',
    'matriz_expense.create',
  ]),
  idempotency_key: idempotencyKeySchema,
});

export const publicDir = path.join(process.cwd(), 'painel', 'public');

export const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const redeQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'month']).default('month'),
});

export const resumoQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'month']).default('7d'),
});

// Recorte dos resumos de venda. Financeiro usa mês; Vendas usa hoje/7d/30d.
export const financePeriodQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'mes', 'tudo']).default('tudo'),
});

// Comissões da Rede (0118): quitar por parceiro + editor do modelo comercial.
export const settleComissaoSchema = z.object({ partner_id: z.string().uuid() });
export const partnerIdParamSchema = z.object({ partner_id: z.string().uuid() });
export const partnerTermsSchema = z.object({
  commercial_model: z.enum(['commission', 'monthly', 'hybrid']),
  commission_percent: z.number().min(0).max(100).nullable(),
  monthly_fee: z.number().min(0).nullable(),
});

// Onboarding de parceiro (Etapa 1). Termos comerciais são definidos pela matriz aqui,
// não pelo candidato. municipios = cobertura inicial; slug opcional (gerado do nome).
export const createPartnerSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  trade_name: z.string().min(2),
  legal_name: z.string().min(1).nullable().optional(),
  document_number: z.string().min(1).nullable().optional(),
  responsible_name: z.string().min(1).nullable().optional(),
  whatsapp_phone: z.string().min(1).nullable().optional(),
  email: z.string().email().nullable().optional(),
  address: z.string().min(1).nullable().optional(),
  commercial_model: z.string().min(1).nullable().optional(),
  commission_percent: z.number().min(0).max(100).nullable().optional(),
  monthly_fee: z.number().min(0).nullable().optional(),
  municipios: z.array(z.string().min(1)).default([]),
  slug: z.string().min(1).nullable().optional(),
});

// Raio de entrega que a MATRIZ define pra um parceiro (proximidade-primeiro Fase 2).
// km livre > 0, ≤ 9999,99 (NUMERIC(6,2)); null = limpar (parceiro sai da entrega).
export const setDeliveryRadiusParamsSchema = z.object({
  partnerUnitId: z.string().uuid(),
});
export const setDeliveryRadiusBodySchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  delivery_radius_km: z.number().positive().max(9999.99).nullable(),
});

// ATACADO (Fase 1): venda de atacado da Matriz. Comprador = ficha existente
// (customer_id), parceiro da rede (partner_id) OU só-atacado novo (new_customer).
// Preço DIGITADO por item. Admin-only (dado só da matriz).
export const wholesaleItemSchema = z.object({
  measure: z.string().min(1).max(60),
  brand: z.string().min(1).max(60).nullable().optional(),
  quantity: z.number().int().positive().max(100000),
  unit_price: z.number().min(0).max(9999999.99),
});
export const registerWholesaleSaleSchema = z
  .object({
    customer_id: z.string().uuid().nullable().optional(),
    partner_id: z.string().uuid().nullable().optional(),
    new_customer: z
      .object({ name: z.string().min(1).max(200), phone: z.string().max(40).nullable().optional() })
      .nullable()
      .optional(),
    items: z.array(wholesaleItemSchema).min(1).max(50),
    sold_at: z.string().min(1).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    idempotency_key: idempotencyKeySchema,
    // FINANCEIRO (0115): 'pending' = fiado (a receber), vencimento opcional.
    // Ignorados com WHOLESALE_FINANCE off (a venda nasce 'paid', como hoje).
    payment_status: z.enum(['paid', 'pending']).optional(),
    due_date: z.string().date().nullable().optional(),
  })
  .refine(
    (d) => !!d.customer_id || !!d.partner_id || !!(d.new_customer && d.new_customer.name.trim()),
    { message: 'buyer_required' },
  );

// ATACADO (Fase 2): estoque do galpão por MEDIDA (gestão + autocomplete). Admin-only.
export const setWholesaleStockSchema = z.object({
  measure: z.string().min(1).max(60),
  quantity_on_hand: z.number().int().min(0).max(1000000),
  unit_cost: z.number().min(0).max(9999999.99).optional(),
  min_quantity: z.number().int().min(0).max(1000000).nullable().optional(), // 0126: null/ausente = sem alerta
  notes: z.string().max(1000).nullable().optional(),
});
export const removeWholesaleStockSchema = z.object({
  measure: z.string().min(1).max(60),
});
// Entrada de compra (custo médio): soma quantidade + recalcula o custo médio ponderado.
export const entryWholesaleStockSchema = z.object({
  measure: z.string().min(1).max(60),
  quantity_in: z.number().int().positive().max(1000000),
  unit_cost: z.number().min(0).max(9999999.99),
});
// Baixa MANUAL com motivo (0128 — quebra/perda/uso interno): recusa acima do saldo.
export const baixaWholesaleStockSchema = z.object({
  measure: z.string().min(1).max(60),
  quantity: z.number().int('quantidade_inteira').positive().max(1000000),
  reason: z.string().min(2).max(300),
});

// ATACADO — FORNECEDORES (0114): cadastro + compra (entrada com origem). Admin-only.
export const registerSupplierSchema = z.object({ name: z.string().min(1).max(200), phone: z.string().max(40).nullable().optional(), document: z.string().max(30).nullable().optional(), notes: z.string().max(1000).nullable().optional() });
export const purchaseItemSchema = z.object({
  measure: z.string().min(1).max(60),
  brand: z.string().min(1).max(60).nullable().optional(),
  // 'quantidade_inteira' = código que o front traduz (o texto cru do zod vaza inglês).
  quantity: z.number().int('quantidade_inteira').positive().max(100000),
  unit_cost: z.number().min(0).max(9999999.99),
});
export const registerPurchaseSchema = z
  .object({
    supplier_id: z.string().uuid().nullable().optional(),
    new_supplier: z
      .object({ name: z.string().min(1).max(200), phone: z.string().max(40).nullable().optional(),
        document: z.string().max(30).nullable().optional() })
      .nullable()
      .optional(),
    items: z.array(purchaseItemSchema).min(1).max(50),
    purchased_at: z.string().min(1).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    // FINANCEIRO (0115): 'pending' = compra fiada (a pagar ao fornecedor).
    payment_status: z.enum(['paid', 'pending']).optional(),
    due_date: z.string().date().nullable().optional(),
    receipt_status: z.enum(['pending', 'received']).default('received'),
    idempotency_key: idempotencyKeySchema,
  })
  .refine((d) => !!d.supplier_id || !!(d.new_supplier && d.new_supplier.name.trim()), {
    message: 'supplier_required',
  });

// Cancelar compra: sai sem apagar; motivo obrigatório fica na trilha.
export const cancelWholesalePurchaseSchema = z.object({ purchase_id: z.string().uuid(), reason: z.string().trim().min(2).max(300), idempotency_key: idempotencyKeySchema });

export const confirmWholesalePurchaseSchema = z.object({ purchase_id: z.string().uuid(), idempotency_key: idempotencyKeySchema });

// ARQUIVAR fornecedor (soft delete): some do form/ranking; compras e dívida ficam.
export const archiveWholesaleSupplierSchema = z.object({
  supplier_id: z.string().uuid(),
});

// FINANCEIRO do atacado (0115): quitar um fiado — venda (a receber) ou compra (a pagar).
export const settleWholesaleFinanceSchema = z.object({
  kind: z.enum(['sale', 'purchase']),
  id: z.string().uuid(),
  idempotency_key: idempotencyKeySchema,
});

// DESPESAS da matriz (0120): lançar (à vista × a pagar), quitar e remover (soft).
export const createMatrizExpenseSchema = z.object({
  // 0130: modalidade virou lista viva — o formato valida aqui; existir E estar
  // ativa valida no banco (guard + FK). z.enum fixo barraria as do dono.
  category: z.string().regex(/^[a-z0-9_]{2,40}$/),
  description: z.string().max(300).nullable().optional(),
  amount: z.number().positive(),
  payment_status: z.enum(['paid', 'pending']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  idempotency_key: idempotencyKeySchema,
});

export const matrizExpenseIdSchema = z.object({
  id: z.string().uuid(),
  idempotency_key: idempotencyKeySchema,
});

export const matrizExpenseRemoveSchema = matrizExpenseIdSchema.extend({
  reason: z.string().trim().min(2).max(300),
});

// 0130: modalidades de despesa cadastráveis + filtro de período da lista.
export const matrizExpenseCategoryCreateSchema = z.object({
  label: z.string().trim().min(2).max(40),
});
export const matrizExpenseCategoryArchiveSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_]{2,40}$/),
});
export const matrizExpensesQuerySchema = z.object({
  mes: z.string().regex(/^\d{4}-\d{2}$/).optional(),       // competência (occurred_at, fuso SP)
  categoria: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(),
});

// Cancelar venda: sai do ranking/resumo/fiado, devolve a baixa comprovada e
// exige motivo para a trilha.
export const cancelWholesaleSaleSchema = z.object({
  order_id: z.string().uuid(),
  reason: z.string().trim().min(2).max(300),
  idempotency_key: idempotencyKeySchema,
});

// Etapa 3: candidatura pública "quero ser parceiro". 'website' é honeypot anti-spam.
export const partnerApplicationSchema = z.object({
  trade_name: z.string().trim().min(2).max(160),
  responsible_name: z.string().trim().min(1).max(160).nullable().optional(),
  whatsapp_phone: z.string().trim().min(1).max(40).nullable().optional(),
  // E-mail é opcional e sem validação de formato: o canal real é o WhatsApp.
  // Vazio vira null pra não derrubar o envio.
  email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().max(160).nullable().optional(),
  ),
  address: z.string().trim().min(1).max(500).nullable().optional(),
  municipios: z.string().trim().min(1).max(500).nullable().optional(),
  message: z.string().max(1000).nullable().optional(),
  website: z.string().max(500).optional(),
});

export const applicationsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
});

// Aprovação: termos comerciais e cobertura REAL são definidos pelo dono aqui.
export const approveApplicationSchema = z.object({
  municipios: z.array(z.string().min(1)).min(1),
  commission_percent: z.number().min(0).max(100).nullable().optional(),
  monthly_fee: z.number().min(0).nullable().optional(),
  commercial_model: z.string().min(1).nullable().optional(),
  slug: z.string().min(1).nullable().optional(),
});

export const orderItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  discount_amount: z.number().nonnegative().optional(),
});

// S6 da auditoria 2026-05-21: pedido de entrega exige endereco.
export const requireDeliveryAddress = (data: { fulfillment_mode: string; delivery_address?: string | null }): boolean =>
  data.fulfillment_mode !== 'delivery' || !!(data.delivery_address && data.delivery_address.trim().length > 0);
export const deliveryAddressRefineOpts = {
  message: 'delivery_address obrigatorio quando fulfillment_mode=delivery',
  path: ['delivery_address'] as (string | number)[],
};

export const registerManualOrderSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  contact_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid(),
  draft_id: z.string().uuid().nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8),
  source_tag: z.enum(['chatwoot_com_bot', 'chatwoot_sem_bot']).nullable().optional(),
}).refine(requireDeliveryAddress, deliveryAddressRefineOpts);

export const registerWalkinOrderSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  customer_name: z.string().min(1).max(200).nullable().optional(),
  customer_phone: z.string().min(1).max(40).nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8),
  source_tag: z.enum(['walkin_balcao', 'walkin_telefone', 'walkin_outro']),
}).refine(requireDeliveryAddress, deliveryAddressRefineOpts);

export const cancelParamsSchema = z.object({
  order_id: z.string().uuid(),
});

export const cancelBodySchema = z.object({
  reason: z.string().min(1).max(500),
});
