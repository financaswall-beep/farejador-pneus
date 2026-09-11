import type { BuscarCompatibilidadeInput } from '../atendente/tools/commerce-tools.js';
import { buscarCompatibilidadeInputSchema } from '../atendente/tools/commerce-tools.js';
import { applicationsForMotorcycle, VEHICLE_APPLICATION_VERSION } from '../shared/vehicle-tire-applications.js';
import { matchCatalogApplications, type CatalogApplication } from '../shared/vehicle-application-catalog.js';

export function compatibilityInput(environment: 'prod' | 'test', args: Record<string, unknown>) {
  return buscarCompatibilidadeInputSchema.parse({
    environment, moto_modelo: args.moto_modelo, moto_ano: args.moto_ano,
    posicao_pneu: args.posicao_pneu, condicao_pneu: args.condicao_pneu, limit: 10,
  });
}

export function vehicleApplicationAnswer(input: BuscarCompatibilidadeInput, catalog?: CatalogApplication[]) {
  const parsed = buscarCompatibilidadeInputSchema.parse(input);
  const lookup = (year?: number) => catalog
    ? matchCatalogApplications(catalog, parsed.moto_modelo, year, parsed.posicao_pneu)
    : applicationsForMotorcycle(parsed.moto_modelo, year, parsed.posicao_pneu);
  const rows = lookup(parsed.moto_ano);
  if (!rows.length) {
    const knownModelRows = parsed.moto_ano
      ? lookup()
      : [];
    if (!knownModelRows.length) return null;
    return {
      encontrado: true,
      tipo_resultado: 'modelo_reconhecido_ano_nao_confirmado',
      versao_catalogo: VEHICLE_APPLICATION_VERSION,
      ano_informado: parsed.moto_ano,
      referencias_de_ano_disponiveis: [...new Set(knownModelRows.map(row => row.year_reference))],
      posicoes_disponiveis: [...new Set(knownModelRows.map(row => row.position))],
      aplicacoes: [],
      total_aplicacoes: 0,
      precisa_confirmar_modelo_versao: false,
      precisa_confirmar_ano: false,
      precisa_confirmar_posicao: !parsed.posicao_pneu || parsed.posicao_pneu === 'both',
      precisa_confirmar_medida: true,
      produto_confirmado: false,
      estoque_consultado: false,
      consultas_de_produto: [],
      mensagem: 'A moto é reconhecida, mas não foi encontrada aplicação confirmada para o ano e a posição informados. Isso não significa falta de estoque.',
      proximo_passo: 'Não pergunte novamente o ano já informado. Se a posição ainda não foi informada, pergunte dianteiro ou traseiro. Depois peça a medida escrita na lateral do pneu, foto da medida ou confirmação no manual. Quando o cliente informar a medida exata, use buscar_produto diretamente. Não use medidas de outros anos, não diga que não há estoque e não escale o atendimento somente por essa lacuna.',
    };
  }
  // Edições diferentes do manual não são versões diferentes da medida.
  // R/ZR continuam explícitos: a busca nominal não homologa construção/índices do SKU.
  const ambiguous = ['front', 'rear'].some(position =>
    new Set(rows.filter(r => r.position === position).map(r => r.tire_size)).size > 1);
  const unknownYears = rows.some(r => r.year_start === null && r.year_end === null);
  const missingPosition = !parsed.posicao_pneu || (parsed.posicao_pneu === 'both'
    && !['front', 'rear'].every(p => rows.some(r => r.position === p)));
  const yearOptional = rows.every(r => 'year_optional' in r && r.year_optional === true);
  const needsYear = !parsed.moto_ano && (ambiguous || !yearOptional || unknownYears);
  const confirmedContext = !ambiguous && !unknownYears && !missingPosition && !needsYear;
  return {
    encontrado: true,
    tipo_resultado: 'aplicacao_de_medida_do_fabricante',
    ano_informado: parsed.moto_ano ?? null,
    versao_catalogo: VEHICLE_APPLICATION_VERSION,
    referencia_em_uso: true,
    requer_aprovacao_manual_da_referencia: false,
    aplicacoes: rows.slice(0, 20),
    total_aplicacoes: rows.length,
    resultado_parcial: rows.length > 20,
    precisa_confirmar_modelo_versao: ambiguous,
    precisa_confirmar_ano: needsYear,
    precisa_confirmar_posicao: missingPosition,
    precisa_confirmar_medida: unknownYears && Boolean(parsed.moto_ano),
    produto_confirmado: false,
    estoque_consultado: false,
    consultas_de_produto: confirmedContext
      ? [...new Set(rows.map(r => r.display_measure))].map(medida_pneu => ({
        medida_pneu, ...(parsed.condicao_pneu ? { condicao_pneu: parsed.condicao_pneu } : {}),
      })) : [],
    mensagem: ambiguous
      ? 'Existem versões/anos diferentes. Apresente as opções e confirme a moto antes de escolher uma medida.'
      : needsYear
        ? 'A medida está documentada nos anos retornados, mas a pesquisa ainda não cobre toda a história deste modelo. Pergunte somente o ano que falta para verificar a faixa correta.'
        : unknownYears
          ? 'A referência não delimita os anos de aplicação. Não peça novamente o ano já informado; confirme a medida para esse veículo antes de consultar produtos.'
      : 'Aplicação encontrada na fonte do fabricante. A faixa inclui o primeiro e o último ano. As referências retornadas usam a mesma medida na posição solicitada: não peça ano ou foto apenas para repetir essa confirmação. Preserve as faixas informadas; ano não delimitado não significa todos os anos. Índices e montagem podem variar entre as referências e devem ser conferidos no produto.',
    proximo_passo: 'Esta referência já está em uso; não peça aprovação ao dono nem ao cliente para consultá-la. Depois de identificar ano/versão e posição, use consultas_de_produto em buscar_produto e mantenha bairro/município conhecidos para consultar preço/estoque. A busca nominal do catálogo agrupado não deve filtrar por posição não cadastrada; a posição da aplicação continua sendo a indicada acima. estoque_consultado=false NÃO significa falta de estoque. Não prometa disponibilidade antes da busca. A equipe confere o pneu específico antes da venda/montagem: não diga que um SKU serve sem conferir construção, índices e montagem. Não troque radial por diagonal nem converta polegadas automaticamente.',
  };
}
