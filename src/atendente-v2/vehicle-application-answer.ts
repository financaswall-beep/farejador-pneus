import type { BuscarCompatibilidadeInput } from '../atendente/tools/commerce-tools.js';
import { buscarCompatibilidadeInputSchema } from '../atendente/tools/commerce-tools.js';
import { applicationsForMotorcycle, VEHICLE_APPLICATION_VERSION } from '../shared/vehicle-tire-applications.js';

export function compatibilityInput(environment: 'prod' | 'test', args: Record<string, unknown>) {
  return buscarCompatibilidadeInputSchema.parse({
    environment, moto_modelo: args.moto_modelo, moto_ano: args.moto_ano,
    posicao_pneu: args.posicao_pneu, condicao_pneu: args.condicao_pneu, limit: 10,
  });
}

export function vehicleApplicationAnswer(input: BuscarCompatibilidadeInput) {
  const parsed = buscarCompatibilidadeInputSchema.parse(input);
  const rows = applicationsForMotorcycle(parsed.moto_modelo, parsed.moto_ano, parsed.posicao_pneu);
  if (!rows.length) return null;
  const configurations = new Set(rows.map(r => `${r.make}:${r.model}:${r.year_reference}`));
  const ambiguous = configurations.size > 1;
  const confirmedContext = !ambiguous && Boolean(parsed.moto_ano)
    && rows.every(r => r.year_start !== null)
    && Boolean(parsed.posicao_pneu && parsed.posicao_pneu !== 'both');
  return {
    encontrado: true,
    tipo_resultado: 'aplicacao_de_medida_do_fabricante',
    versao_catalogo: VEHICLE_APPLICATION_VERSION,
    referencia_em_uso: true,
    requer_aprovacao_manual_da_referencia: false,
    aplicacoes: rows.slice(0, 20),
    total_aplicacoes: rows.length,
    resultado_parcial: rows.length > 20,
    precisa_confirmar_modelo_versao: ambiguous,
    precisa_confirmar_ano: !parsed.moto_ano || rows.some(r => r.year_start === null),
    precisa_confirmar_posicao: !parsed.posicao_pneu || parsed.posicao_pneu === 'both',
    produto_confirmado: false,
    estoque_consultado: false,
    consultas_de_produto: confirmedContext
      ? [...new Set(rows.map(r => r.display_measure))].map(medida_pneu => ({
        medida_pneu, ...(parsed.condicao_pneu ? { condicao_pneu: parsed.condicao_pneu } : {}),
      })) : [],
    mensagem: ambiguous
      ? 'Existem versões/anos diferentes. Apresente as opções e confirme a moto antes de escolher uma medida.'
      : 'Aplicação encontrada na fonte do fabricante. Responda a medida e a posição no contexto de ano/versão indicado. Ano não delimitado não significa todos os anos.',
    proximo_passo: 'Esta referência já está em uso; não peça aprovação ao dono nem ao cliente para consultá-la. Depois de identificar ano/versão e posição, use consultas_de_produto em buscar_produto e mantenha bairro/município conhecidos para consultar preço/estoque. A busca nominal do catálogo agrupado não deve filtrar por posição não cadastrada; a posição da aplicação continua sendo a indicada acima. estoque_consultado=false NÃO significa falta de estoque. Não prometa disponibilidade antes da busca. A equipe confere o pneu específico antes da venda/montagem: não diga que um SKU serve sem conferir construção, índices e montagem. Não troque radial por diagonal nem converta polegadas automaticamente.',
  };
}
