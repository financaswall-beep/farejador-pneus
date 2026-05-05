import { z } from 'zod';

export const policyValueSchemas = {
  // --- chaves estruturadas (tipadas) ---
  desconto_maximo: z.object({
    pct: z.number().min(0).max(100),
    max_value_brl: z.number().min(0).optional(),
  }),
  formas_pagamento_aceitas: z.array(z.string().trim().min(1)).min(1),
  prazo_garantia_pneus: z.object({
    days: z.number().int().min(0),
  }),
  free_shipping_threshold: z.object({
    min_value_brl: z.number().min(0),
  }),
  parcelamento_maximo: z.object({
    installments: z.number().int().min(1),
    min_installment_brl: z.number().min(0).optional(),
  }),

  // --- chaves informativas (texto livre / booleano) ---
  area_entrega: z.string(),
  emite_nota_fiscal: z.boolean(),
  endereco: z.string(),
  faz_montagem: z.boolean(),
  garantia_descricao: z.string(),
  horario_funcionamento: z.string(),
  link_maps: z.string(),
  politica_montagem: z.string(),
  prazo_entrega_descricao: z.string(),
  rotas_hoje: z.string().nullable(),
  telefone_atendimento_humano: z.string(),
} as const;

export type KnownPolicyKey = keyof typeof policyValueSchemas;

export function isKnownPolicyKey(policyKey: string): policyKey is KnownPolicyKey {
  return Object.prototype.hasOwnProperty.call(policyValueSchemas, policyKey);
}

export function parsePolicyValue(policyKey: string, value: unknown): unknown {
  if (!isKnownPolicyKey(policyKey)) {
    throw new Error(`unsupported_policy_key:${policyKey}`);
  }
  return policyValueSchemas[policyKey].parse(value);
}
