import type { BuscarCompatibilidadeInput } from '../atendente/tools/commerce-tools.js';
import type { CatalogApplication } from '../shared/vehicle-application-catalog.js';
import { VEHICLE_APPLICATION_VERSION } from '../shared/vehicle-tire-applications.js';

function rim(row: CatalogApplication): number | undefined {
  const value = /(?:ZR|R|B|-)(\d{2})$/i.exec(row.tire_size.replace(/\s/g, ''));
  return value ? Number(value[1]) : undefined;
}

function size(row: CatalogApplication): string {
  return row.tire_size.toUpperCase().replace(/\s/g, '');
}

// Comparamos os eixos dentro de cada versão: duas versões com aros diferentes
// podem, cada uma, usar pneus iguais na dianteira e na traseira.
function axleCoverage(rows: CatalogApplication[]) {
  const models = new Map<string, {front: Set<string>; rear: Set<string>}>();
  for (const row of rows) {
    const key = JSON.stringify([row.make, row.model, row.vehicle_variant, row.year_start, row.year_end]);
    const axles = models.get(key) ?? { front: new Set<string>(), rear: new Set<string>() };
    axles[row.position].add(size(row));
    models.set(key, axles);
  }
  const axles = [...models.values()];
  return {
    incomplete: axles.some(({front, rear}) => !front.size || !rear.size),
    different: axles.some(({front, rear}) =>
      front.size !== rear.size || [...front].some(value => !rear.has(value))),
  };
}

export function carApplicationAnswer(input: BuscarCompatibilidadeInput, rows: CatalogApplication[],
  enteredRim?: number) {
  const candidates = enteredRim === undefined ? rows : rows.filter(row => rim(row) === enteredRim);
  const measures = new Set(candidates.map(size));
  const rims = [...new Set(candidates.map(rim))];
  const axles = axleCoverage(rows);
  const unknownYears = candidates.some(row => row.year_start === null && row.year_end === null);
  const missingYear = !input.moto_ano && !rows.every(row => row.year_optional);
  const missingPosition = !input.posicao_pneu && axles.different;
  const incompletePair = input.posicao_pneu === 'both' && (axles.incomplete || axleCoverage(candidates).incomplete);
  const normalized = (s: string) => s.toLowerCase().replace(/[^\p{L}\d]+/gu, ' ').trim();
  const model = ' ' + normalized(input.moto_modelo) + ' ';
  // Uma única versão no catálogo não demonstra que a família inteira usa sua medida.
  const singleUnconfirmedTrim = new Set(rows.map(row => row.model)).size === 1 &&
    rows.some(row => row.vehicle_variant && !model.includes(' ' + normalized(row.vehicle_variant) + ' '));
  // Duas medidas de eixos distintos são resolvidas juntas em um pedido dos dois eixos.
  const ambiguous = (['front', 'rear'] as const).some(axis =>
    new Set(candidates.filter(row => row.position === axis).map(size)).size > 1);
  const needsRim = ambiguous && enteredRim === undefined && !rims.includes(undefined) && rims.length === measures.size;
  const needsSize = !candidates.length || unknownYears || incompletePair || (ambiguous && !needsRim);
  const needsTrim = singleUnconfirmedTrim && !needsSize && !needsRim;
  const confirmed = !(missingYear || needsSize || needsTrim || needsRim || missingPosition);
  const hasManualReference = candidates.some(row => row.validation_scope === 'catalog_measure');
  const instruction = missingYear ? 'Qual é o ano-modelo do carro?'
    : needsSize ? 'Qual é a medida completa escrita na lateral do pneu que você procura?'
    : needsRim ? 'No seu pneu aparece ' + rims.sort((a,b) => Number(a)-Number(b)).map(r => 'R' + r).join(' ou ') + '?'
    : needsTrim ? 'Qual é a versão do carro ou a medida completa escrita no pneu?'
    : missingPosition ? 'Você procura o pneu dianteiro ou o traseiro?'
    : hasManualReference ? 'Medida cadastrada pela Matriz para a aplicação informada.'
    : 'Medida documentada pelo fabricante para a aplicação informada.';
  const positionsByMeasure: Record<string, Array<'front' | 'rear'>> = {};
  for (const {display_measure, position} of candidates) {
    const positions = positionsByMeasure[display_measure] ??= [];
    if (!positions.includes(position)) positions.push(position);
  }
  return {
    encontrado: true,
    tipo_resultado: !candidates.length ? 'aro_sem_aplicacao_confirmada'
      : hasManualReference ? 'aplicacao_de_medida_do_catalogo' : 'aplicacao_de_medida_do_fabricante',
    versao_catalogo: VEHICLE_APPLICATION_VERSION, ano_informado: input.moto_ano ?? null,
    referencia_em_uso: true, requer_aprovacao_manual_da_referencia: false,
    aplicacoes: candidates.slice(0, 20), total_aplicacoes: candidates.length, resultado_parcial: candidates.length > 20,
    posicoes_por_medida: positionsByMeasure,
    precisa_confirmar_ano: missingYear, precisa_confirmar_modelo_versao: needsTrim,
    precisa_confirmar_aro: needsRim, precisa_confirmar_posicao: missingPosition && !needsSize && !needsRim && !needsTrim,
    precisa_confirmar_medida: needsSize, produto_confirmado: false, estoque_consultado: false,
    consultas_de_produto: confirmed ? [...new Set(candidates.map(row => row.display_measure))].map(medida_pneu => ({
      medida_pneu, tipo_veiculo: 'car' as const, ...(input.condicao_pneu ? { condicao_pneu: input.condicao_pneu } : {}),
    })) : [],
    mensagem: instruction,
    proximo_passo: confirmed ? 'Confira a disponibilidade na loja que atende o cliente e os índices e construção do produto.'
      : 'Faça a pergunta indicada em mensagem. Reutilize modelo e ano na resposta curta; a falta de oferta não muda a aplicação.',
  };
}
