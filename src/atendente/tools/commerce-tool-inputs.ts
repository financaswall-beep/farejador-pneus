import { z } from 'zod';

const tirePositionSchema = z.enum(['front', 'rear', 'both']);
const tireConditionSchema = z.enum(['meia_vida', 'novo', 'remold']);

export const buscarProdutoInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  medida_pneu: z.string().trim().min(1).optional(),
  marca: z.string().trim().min(1).optional(),
  condicao_pneu: tireConditionSchema.optional(),
  posicao_pneu: tirePositionSchema.optional(),
  product_code: z.string().trim().min(1).optional(),
  apenas_com_estoque: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(10),
}).refine((data) => Boolean(
  data.medida_pneu || data.marca || data.condicao_pneu || data.product_code,
), {
  message: 'buscarProduto exige medida_pneu, marca, condicao_pneu ou product_code',
});

export const verificarEstoqueInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  product_id: z.string().uuid().optional(),
  product_code: z.string().trim().min(1).optional(),
}).refine((data) => Boolean(data.product_id || data.product_code), {
  message: 'verificarEstoque exige product_id ou product_code',
});

export const buscarCompatibilidadeInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  moto_modelo: z.string().trim().min(1),
  moto_ano: z.number().int().min(1900).max(2100).optional(),
  posicao_pneu: tirePositionSchema.optional(),
  condicao_pneu: tireConditionSchema.optional(),
  limit: z.number().int().min(1).max(20).default(10),
});

export const calcularFreteInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  bairro: z.string().trim().min(1),
  municipio: z.string().trim().min(1).optional(),
});

export const buscarPoliticaComercialInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  policy_keys: z.array(z.string().trim().min(1)).max(20).optional(),
});

export type BuscarProdutoInput = z.infer<typeof buscarProdutoInputSchema>;
export type VerificarEstoqueInput = z.infer<typeof verificarEstoqueInputSchema>;
export type BuscarCompatibilidadeInput = z.infer<typeof buscarCompatibilidadeInputSchema>;
export type CalcularFreteInput = z.infer<typeof calcularFreteInputSchema>;
export type BuscarPoliticaComercialInput = z.infer<typeof buscarPoliticaComercialInputSchema>;
