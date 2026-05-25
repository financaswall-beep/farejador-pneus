/**
 * Zod schemas for each fact_key in the moto-pneus extraction schema (Fase 3).
 *
 * Source of truth: segments/moto-pneus/extraction-schema.json (schema_version: moto-pneus-v1)
 *
 * Usage:
 * - The Organizadora worker validates every fact extracted by the LLM against these schemas.
 * - A fact_key absent from FACT_KEY_SCHEMAS is a schema_violation → ops.agent_incidents.
 * - Validation failure on a known key also blocks the fact (logged as schema_violation).
 * - These schemas validate the `fact_value` field (the JSONB stored in analytics.conversation_facts).
 *
 * Convention:
 * - Each schema validates the VALUE, not the full fact row.
 * - We keep it simple: primitives for leaf types, z.string() for enums (TEXT in DB).
 *   Promote to z.enum() only after 4-8 weeks of stable taxonomy.
 */

import { z } from 'zod';

// ------------------------------------------------------------------
// Category: vehicle
// ------------------------------------------------------------------

/** Marca da moto, ex: "Honda", "Yamaha" */
const motoMarcaSchema = z.string().min(1).max(50);

/** Modelo da moto, ex: "CG 160", "XRE 300" */
const motoModeloSchema = z.string().min(1).max(80);

/** Ano da moto */
const motoAnoSchema = z.number().int().min(1980).max(2030);

/** Cilindrada em cc */
const motoCilindradaSchema = z.number().int().min(50).max(2500);

/** Uso principal */
const motoUsoSchema = z.enum([
  'trabalho',
  'passeio',
  'delivery',
  'aplicativo',
  'viagem',
  'trilha',
  'esporte',
  'uso_misto',
]);

// ------------------------------------------------------------------
// Category: product_search
// ------------------------------------------------------------------

/** Medida do pneu no formato 140/70-17 */
const medidaPneuSchema = z.string().regex(/^\d{2,3}\/\d{2,3}-\d{2}$/, {
  message: 'medida_pneu must match format WW/AA-DD (e.g. 140/70-17)',
});

/** Posição do pneu */
const posicaoPneuSchema = z.enum(['dianteiro', 'traseiro', 'ambos']);

/** Marca preferida */
const marcaPneuPreferidaSchema = z.string().min(1).max(80);

/** Marca recusada */
const marcaPneuRecusadaSchema = z.string().min(1).max(80);

/** Quantidade de pneus */
const quantidadePneusSchema = z.number().int().min(1).max(4);

// ------------------------------------------------------------------
// Category: intent
// ------------------------------------------------------------------

const intencaoClienteSchema = z.enum([
  'comprar_pneu',
  'consultar_preco',
  'consultar_estoque',
  'consultar_compatibilidade',
  'consultar_entrega',
  'trocar_pneu',
  'duvida_geral',
  'reclamacao',
  'garantia',
  'concorrente_orcamento',
  'outro',
]);

const motivoCompraSchema = z.enum([
  'pneu_furou',
  'pneu_careca',
  'troca_preventiva',
  'viagem_proxima',
  'trabalho_diario',
  'delivery_app',
  'seguranca',
  'indicacao_mecanico',
  'promocao',
  'outro',
]);

const urgenciaSchema = z.enum(['alta', 'media', 'baixa']);

// ------------------------------------------------------------------
// Category: preference
// ------------------------------------------------------------------

const preferenciaPrincipalSchema = z.enum([
  'preco',
  'durabilidade',
  'marca_conhecida',
  'pronta_entrega',
  'qualidade',
  'indicacao',
  'nao_sabe',
]);

/** Faixa de preço sinalizada, texto livre (normalizado pelo LLM) */
const faixaPrecoDesejedaSchema = z.string().min(1).max(50);

const aceitaAlternativaSchema = z.boolean();

// ------------------------------------------------------------------
// Category: delivery
// ------------------------------------------------------------------

const bairroMencionadoSchema = z.string().min(1).max(100);

const municipioMencionadoSchema = z.string().min(1).max(100);

const modalidadeEntregaSchema = z.enum(['entrega', 'retirada', 'indefinido']);

const perguntouEntregaHojeSchema = z.boolean();

// ------------------------------------------------------------------
// Category: payment
// ------------------------------------------------------------------

const formaPagamentoSchema = z.enum([
  'pix',
  'cartao_credito',
  'cartao_debito',
  'dinheiro',
  'boleto',
  'indefinido',
]);

// ------------------------------------------------------------------
// Category: negotiation
// ------------------------------------------------------------------

const pediuDescontoSchema = z.boolean();

const perguntouParcelamentoSchema = z.boolean();

const achouCaroSchema = z.boolean();

// ------------------------------------------------------------------
// Category: competition
// ------------------------------------------------------------------

const concorrenteCitadoSchema = z.string().min(1).max(100);

const precoConcorrenteSchema = z.number().min(0);

// ------------------------------------------------------------------
// Category: quote (loja afirmou valor — NAO confundir com faixa_preco_desejada do cliente)
// ------------------------------------------------------------------

/**
 * Preco que o ATENDENTE/BOT cotou explicitamente na conversa.
 * Ex: "fica 99 reais", "sai a 89", "ta saindo a 120".
 * NAO confundir com faixa_preco_desejada (orcamento expresso pelo cliente)
 * nem com preco_concorrente (valor citado de outra loja).
 */
const precoCotadoSchema = z.number().positive();

/**
 * Taxa de frete que o ATENDENTE/BOT cotou explicitamente na conversa.
 * Ex: "frete sai 9,90", "entrega 19 reais", "frete gratis" -> 0.
 */
const taxaFreteCotadaSchema = z.number().nonnegative();

// ------------------------------------------------------------------
// Category: outcome
// ------------------------------------------------------------------

/** Texto livre: qual produto foi ofertado */
const produtoOferecidoSchema = z.string().min(1).max(200);

const produtoAceito = z.boolean();

const produtoRecusadoMotivoSchema = z.enum([
  'preco',
  'marca',
  'prazo',
  'estoque',
  'duvida',
  'comprou_concorrente',
  'outro',
]);

// ------------------------------------------------------------------
// Category: operational
// ------------------------------------------------------------------

const pediuHumanoSchema = z.boolean();

// ------------------------------------------------------------------
// Category: cancellation (capturada quando cliente desiste/cancela)
// ------------------------------------------------------------------

/** Cliente cancelou o pedido explicitamente apos cotacao/aceite. */
const pedidoCanceladoSchema = z.boolean();

/**
 * Motivo do cancelamento, capturado do que cliente disse.
 * - sem_grana: "to sem grana", "to liso", "nao tenho dinheiro agora"
 * - mudou_de_ideia: "muda de ideia", "esquece", "deixa pra outro dia"
 * - comprou_concorrente: "comprei em outra loja", "ja comprei"
 * - preco_alto: "ficou caro", "ta acima do meu orcamento"
 * - sem_pressa: "vou pensar", "depois vejo"
 * - outro: motivo nao mapeado
 */
const motivoCancelamentoSchema = z.enum([
  'sem_grana',
  'mudou_de_ideia',
  'comprou_concorrente',
  'preco_alto',
  'sem_pressa',
  'outro',
]);

// ------------------------------------------------------------------
// Category: identity (PII)
// ------------------------------------------------------------------

/** PII — masked in logs. */
const nomeClienteSchema = z.string().min(1).max(120);

// ------------------------------------------------------------------
// Registry: fact_key → value schema
//
// This is the single whitelist. Organizadora worker calls:
//   FACT_KEY_SCHEMAS[factKey]?.safeParse(factValue)
// If the key is missing → schema_violation incident.
// If safeParse fails → schema_violation incident.
// ------------------------------------------------------------------

export const FACT_KEY_SCHEMAS = {
  // vehicle
  moto_marca:                  motoMarcaSchema,
  moto_modelo:                 motoModeloSchema,
  moto_ano:                    motoAnoSchema,
  moto_cilindrada:             motoCilindradaSchema,
  moto_uso:                    motoUsoSchema,

  // product_search
  medida_pneu:                 medidaPneuSchema,
  posicao_pneu:                posicaoPneuSchema,
  marca_pneu_preferida:        marcaPneuPreferidaSchema,
  marca_pneu_recusada:         marcaPneuRecusadaSchema,
  quantidade_pneus:            quantidadePneusSchema,

  // intent
  intencao_cliente:            intencaoClienteSchema,
  motivo_compra:               motivoCompraSchema,
  urgencia:                    urgenciaSchema,

  // preference
  preferencia_principal:       preferenciaPrincipalSchema,
  faixa_preco_desejada:        faixaPrecoDesejedaSchema,
  aceita_alternativa:          aceitaAlternativaSchema,

  // delivery
  bairro_mencionado:           bairroMencionadoSchema,
  municipio_mencionado:        municipioMencionadoSchema,
  modalidade_entrega:          modalidadeEntregaSchema,
  perguntou_entrega_hoje:      perguntouEntregaHojeSchema,

  // payment
  forma_pagamento:             formaPagamentoSchema,

  // negotiation
  pediu_desconto:              pediuDescontoSchema,
  perguntou_parcelamento:      perguntouParcelamentoSchema,
  achou_caro:                  achouCaroSchema,

  // competition
  concorrente_citado:          concorrenteCitadoSchema,
  preco_concorrente:           precoConcorrenteSchema,

  // quote (loja afirmou valor)
  preco_cotado:                precoCotadoSchema,
  taxa_frete_cotada:           taxaFreteCotadaSchema,

  // outcome
  produto_oferecido:           produtoOferecidoSchema,
  produto_aceito:              produtoAceito,
  produto_recusado_motivo:     produtoRecusadoMotivoSchema,

  // operational
  pediu_humano:                pediuHumanoSchema,

  // cancellation
  pedido_cancelado:            pedidoCanceladoSchema,
  motivo_cancelamento:         motivoCancelamentoSchema,

  // identity (PII)
  nome_cliente:                nomeClienteSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type FactKey = keyof typeof FACT_KEY_SCHEMAS;

/** All allowed fact_key strings as a runtime array. */
export const VALID_FACT_KEYS: readonly FactKey[] = Object.keys(FACT_KEY_SCHEMAS) as FactKey[];

/**
 * Validate a fact_value for a given fact_key.
 * Returns the Zod parse result, or null if the key is not in the whitelist.
 *
 * @example
 * const result = validateFactValue('medida_pneu', '140/70-17');
 * if (!result) throw new Error('schema_violation: unknown fact_key');
 * if (!result.success) throw new Error('schema_violation: invalid value');
 */
export function validateFactValue(
  factKey: string,
  factValue: unknown,
): z.SafeParseReturnType<unknown, unknown> | null {
  const schema = FACT_KEY_SCHEMAS[factKey as FactKey];
  if (!schema) return null;
  return schema.safeParse(factValue);
}
