import { z } from 'zod';
import { sessionSlotKeySchema } from '../../shared/zod/agent-state.js';
import {
  buscarCompatibilidadeInputSchema,
  buscarPoliticaComercialInputSchema,
  buscarProdutoInputSchema,
  calcularFreteInputSchema,
  verificarEstoqueInputSchema,
} from '../tools/commerce-tools.js';

export const plannerPromptVersion = 'planner_v1.2.9';

export const skillNameSchema = z.enum([
  'responder_geral',
  'pedir_dados_faltantes',
  'buscar_e_ofertar',
  'responder_logistica',
  'tratar_objecao',
  'registrar_intencao_fechamento',
  'escalar_humano',
]);
export type SkillName = z.infer<typeof skillNameSchema>;

export const riskFlagSchema = z.enum([
  'mentions_price',
  'mentions_stock',
  'mentions_delivery',
  'mentions_discount',
  'customer_frustrated',
  'human_requested',
  'low_confidence',
  'stale_slot_present',
  'closing_intent',
]);
export type RiskFlag = z.infer<typeof riskFlagSchema>;

export const toolNameSchema = z.enum([
  'buscarProduto',
  'verificarEstoque',
  'buscarCompatibilidade',
  'calcularFrete',
  'buscarPoliticaComercial',
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const toolRequestSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('buscarProduto'), input: buscarProdutoInputSchema }),
  z.object({ tool: z.literal('verificarEstoque'), input: verificarEstoqueInputSchema }),
  z.object({ tool: z.literal('buscarCompatibilidade'), input: buscarCompatibilidadeInputSchema }),
  z.object({ tool: z.literal('calcularFrete'), input: calcularFreteInputSchema }),
  z.object({ tool: z.literal('buscarPoliticaComercial'), input: buscarPoliticaComercialInputSchema }),
]);
export type ToolRequest = z.infer<typeof toolRequestSchema>;

export const plannerOutputSchema = z.object({
  skill: skillNameSchema,
  missing_slots: z.array(sessionSlotKeySchema).default([]),
  tool_requests: z.array(toolRequestSchema).max(5).default([]),
  risk_flags: z.array(riskFlagSchema).default([]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(800),
  prompt_version: z.literal(plannerPromptVersion),
});
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export const plannerOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['skill', 'missing_slots', 'tool_requests', 'risk_flags', 'confidence', 'rationale', 'prompt_version'],
  properties: {
    skill: { type: 'string', enum: skillNameSchema.options },
    missing_slots: {
      type: 'array',
      items: { type: 'string' },
    },
    tool_requests: {
      type: 'array',
      maxItems: 5,
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['tool', 'input'],
            properties: {
              tool: { type: 'string', enum: ['buscarProduto'] },
              input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  environment: { type: 'string' },
                  medida_pneu: { type: ['string', 'null'] },
                  marca: { type: ['string', 'null'] },
                  product_code: { type: ['string', 'null'] },
                  posicao_pneu: { type: ['string', 'null'], enum: ['front', 'rear', 'both', null] },
                  apenas_com_estoque: { type: ['boolean', 'null'] },
                  limit: { type: ['number', 'null'] },
                },
                required: [
                  'environment',
                  'medida_pneu',
                  'marca',
                  'product_code',
                  'posicao_pneu',
                  'apenas_com_estoque',
                  'limit',
                ],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['tool', 'input'],
            properties: {
              tool: { type: 'string', enum: ['verificarEstoque'] },
              input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  environment: { type: 'string' },
                  product_id: { type: ['string', 'null'] },
                  product_code: { type: ['string', 'null'] },
                },
                required: ['environment', 'product_id', 'product_code'],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['tool', 'input'],
            properties: {
              tool: { type: 'string', enum: ['buscarCompatibilidade'] },
              input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  environment: { type: 'string' },
                  moto_modelo: { type: 'string' },
                  moto_ano: { type: ['number', 'null'] },
                  posicao_pneu: { type: ['string', 'null'], enum: ['front', 'rear', 'both', null] },
                  limit: { type: ['number', 'null'] },
                },
                required: ['environment', 'moto_modelo', 'moto_ano', 'posicao_pneu', 'limit'],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['tool', 'input'],
            properties: {
              tool: { type: 'string', enum: ['calcularFrete'] },
              input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  environment: { type: 'string' },
                  bairro: { type: 'string' },
                  municipio: { type: ['string', 'null'] },
                },
                required: ['environment', 'bairro', 'municipio'],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['tool', 'input'],
            properties: {
              tool: { type: 'string', enum: ['buscarPoliticaComercial'] },
              input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  environment: { type: 'string' },
                  policy_keys: {
                    anyOf: [
                      { type: 'array', items: { type: 'string' } },
                      { type: 'null' },
                    ],
                  },
                },
                required: ['environment', 'policy_keys'],
              },
            },
          },
        ],
      },
    },
    risk_flags: {
      type: 'array',
      items: { type: 'string', enum: riskFlagSchema.options },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', minLength: 1, maxLength: 800 },
    prompt_version: { type: 'string', enum: [plannerPromptVersion] },
  },
} as const;

export function fallbackPlannerOutput(reason: string): PlannerOutput {
  return {
    skill: 'escalar_humano',
    missing_slots: [],
    tool_requests: [],
    risk_flags: ['low_confidence'],
    confidence: 0,
    rationale: reason.slice(0, 800) || 'planner fallback',
    prompt_version: plannerPromptVersion,
  };
}
