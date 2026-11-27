import type { BuscarCompatibilidadeInput, CompatibilidadeResultado } from '../atendente/tools/commerce-tools.js';
import { buscarCompatibilidadeInputSchema } from '../atendente/tools/commerce-tools.js';
import { applicationsForMotorcycle, VEHICLE_APPLICATION_VERSION } from '../shared/vehicle-tire-applications.js';
import { knownCarFamily, matchCatalogApplications, type CatalogApplication } from '../shared/vehicle-application-catalog.js';
import type { TireVehicleType } from '../shared/tire-vehicle-type.js';
import { carApplicationAnswer } from './car-application-selection.js';

export function compatibilityInput(environment: 'prod' | 'test', args: Record<string, unknown>) {
  return buscarCompatibilidadeInputSchema.parse({
    environment, moto_modelo: args.modelo ?? args.moto_modelo, moto_ano: args.ano ?? args.moto_ano,
    tipo_veiculo: args.tipo_veiculo ?? (args.modelo == null ? 'motorcycle' : undefined),
    posicao_pneu: args.posicao_pneu, condicao_pneu: args.condicao_pneu, limit: 10,
  });
}

function mentionsVariant(model: string, variant?: string | null) {
  const words = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return !variant || (` ${words(model)} `).includes(` ${words(variant)} `);
}

export function approvedFitmentContext(input: BuscarCompatibilidadeInput, vehicles: CompatibilidadeResultado[]) {
  const car = input.tipo_veiculo === 'car';
  const needsModel = new Set(vehicles.map(v => JSON.stringify([v.make,v.model,v.variant]))).size > 1
    || (car && vehicles.some(v => !mentionsVariant(input.moto_modelo, v.variant)));
  // Um SKU só dispensa a pergunta sobre eixo quando o próprio vínculo cobre os dois.
  const bothAxles = car && vehicles.every(({ produtos }) => {
    const front = new Set(produtos.filter(p => p.position !== 'rear').map(p => p.product_id));
    const rear = new Set(produtos.filter(p => p.position !== 'front').map(p => p.product_id));
    return front.size === rear.size && [...front].every(id => rear.has(id));
  });
  return { precisa_confirmar_modelo_versao: needsModel, precisa_confirmar_ano: !input.moto_ano,
    precisa_confirmar_posicao: !input.posicao_pneu && !bothAxles };
}

export function vehicleApplicationAnswer(input: BuscarCompatibilidadeInput, catalog?: CatalogApplication[], vehicleType: TireVehicleType = input.tipo_veiculo ?? 'motorcycle', enteredRim?: number) {
  const parsed = buscarCompatibilidadeInputSchema.parse(input);
  const lookup = (year?: number): CatalogApplication[] => catalog
    ? matchCatalogApplications(catalog, parsed.moto_modelo, year, parsed.posicao_pneu, vehicleType)
    : vehicleType === 'motorcycle' ? applicationsForMotorcycle(parsed.moto_modelo, year, parsed.posicao_pneu) : [];
  const rows = lookup(parsed.moto_ano);
  if (!rows.length) {
    const knownModelRows = parsed.moto_ano
      ? lookup()
      : [];
    if (!knownModelRows.length && !(vehicleType === 'car' && catalog && knownCarFamily(catalog, parsed.moto_modelo))) return null;
    return {
      encontrado: true,
      tipo_resultado: knownModelRows.length ? 'modelo_reconhecido_ano_nao_confirmado' : 'versao_ou_eixo_sem_aplicacao',
      versao_catalogo: VEHICLE_APPLICATION_VERSION,
      ano_informado: parsed.moto_ano,
      referencias_de_ano_disponiveis: [...new Set(knownModelRows.map(row => row.year_reference))],
      posicoes_disponiveis: [...new Set(knownModelRows.map(row => row.position))],
      aplicacoes: [],
      total_aplicacoes: 0,
      precisa_confirmar_modelo_versao: false,
      precisa_confirmar_ano: false,
      precisa_confirmar_posicao: vehicleType === 'motorcycle' && (!parsed.posicao_pneu || parsed.posicao_pneu === 'both'),
      precisa_confirmar_medida: true,
      produto_confirmado: false,
      estoque_consultado: false,
      consultas_de_produto: [],
      mensagem: 'O modelo é reconhecido, mas falta aplicação confirmada para o ano e a posição informados.',
      proximo_passo: 'Peça a medida escrita na lateral ou a confirmação no manual. Foto sem inscrição na legenda requer leitura pela equipe. Pergunte posição apenas se precisa_confirmar_posicao=true. Com a medida exata, use buscar_produto diretamente. Não repita o ano, não use a medida de outra geração e não conclua que falta estoque.',
    };
  }
  // Edições diferentes do manual não são versões diferentes da medida.
  // R/ZR continuam explícitos: a busca nominal não homologa construção/índices do SKU.
  if (vehicleType === 'car') return carApplicationAnswer(parsed, rows, enteredRim);
  const ambiguous = ['front', 'rear'].some(position =>
    new Set(rows.filter(r => r.position === position).map(r => r.tire_size)).size > 1);
  const unknownYears = rows.some(r => r.year_start === null && r.year_end === null);
  const partialPair = parsed.posicao_pneu === 'both' && !['front','rear'].every(p => rows.some(r => r.position === p));
  const missingPosition = !parsed.posicao_pneu || partialPair;
  const yearOptional = rows.every(r => 'year_optional' in r && r.year_optional === true);
  const needsYear = !parsed.moto_ano && (!yearOptional || unknownYears || (vehicleType === 'motorcycle' && ambiguous));
  const confirmedContext = !ambiguous && !unknownYears && !missingPosition && !partialPair && !needsYear;
  const hasCatalogReference = rows.some(row => row.validation_scope === 'catalog_measure');
  return {
    encontrado: true,
    tipo_resultado: hasCatalogReference ? 'aplicacao_de_medida_do_catalogo' : 'aplicacao_de_medida_do_fabricante',
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
        medida_pneu, tipo_veiculo: vehicleType, ...(parsed.condicao_pneu ? { condicao_pneu: parsed.condicao_pneu } : {}),
      })) : [],
    mensagem: ambiguous
      ? 'Apresente as versões encontradas e confirme o modelo antes de escolher uma medida.'
      : needsYear
        ? 'A medida está documentada nos anos retornados, mas a pesquisa ainda não cobre toda a história deste modelo. Pergunte somente o ano que falta para verificar a faixa correta.'
        : unknownYears
          ? 'A referência não delimita os anos de aplicação. Não peça novamente o ano já informado; confirme a medida para esse veículo antes de consultar produtos.'
      : hasCatalogReference
        ? 'A Matriz cadastrou a medida para o modelo, os anos e a posição indicados. Confira índices e montagem no pneu específico.'
        : 'Aplicação encontrada na fonte do fabricante. A faixa inclui o primeiro e o último ano. As referências retornadas usam a mesma medida na posição solicitada: não peça ano ou foto apenas para repetir essa confirmação. Preserve as faixas informadas; ano não delimitado não significa todos os anos. Índices e montagem podem variar entre as referências e devem ser conferidos no produto.',
    proximo_passo: 'Esta referência já está em uso; não peça aprovação ao dono nem ao cliente para consultá-la. Depois de identificar ano/versão e posição, use consultas_de_produto em buscar_produto e mantenha bairro/município conhecidos para consultar preço/estoque. A busca nominal do catálogo agrupado não deve filtrar por posição não cadastrada; a posição da aplicação continua sendo a indicada acima. estoque_consultado=false NÃO significa falta de estoque. Não prometa disponibilidade antes da busca. A equipe confere o pneu específico antes da venda/montagem: não diga que um SKU serve sem conferir construção, índices e montagem. Não troque radial por diagonal nem converta polegadas automaticamente.',
  };
}
