import type { PoolClient } from 'pg';
import type { BuscarCompatibilidadeInput } from '../atendente/tools/commerce-tools.js';
import { env } from '../shared/config/env.js';
import { loadVehicleApplicationCatalog } from '../shared/vehicle-application-catalog.js';
import { reportCarProductFitment } from './car-product-fitment.js';
import { getLatestCustomerLocation } from './customer-location.js';
import { vehicleApplicationAnswer } from './vehicle-application-answer.js';

type Application = NonNullable<ReturnType<typeof vehicleApplicationAnswer>>;
type Search = Application['consultas_de_produto'][number] & { posicao_pneu: 'front' | 'rear' | 'both' };
export type MeasureSearch = (query: Search) => Promise<Record<string, unknown>>;

export async function lookupCarApplication(client: PoolClient, conversationId: string, input: BuscarCompatibilidadeInput,
  args: Record<string, unknown>, search: MeasureSearch): Promise<string | null> {
  const {environment} = input;
  if (args.aro !== undefined && (!Number.isInteger(args.aro) || Number(args.aro) < 8 || Number(args.aro) > 30)) {
    return JSON.stringify({erro: 'aro_invalido', mensagem: 'Informe o número escrito depois de R ou peça a medida completa.'});
  }
  // A busca técnica percorre também as versões sem SKU e sem saldo.
  const catalog = await loadVehicleApplicationCatalog(client, environment, undefined, 'car');
  const application = vehicleApplicationAnswer(input, catalog, 'car', args.aro as number | undefined);
  if (!application) return null;
  if (application.consultas_de_produto.length && typeof args.produto_id === 'string')
    return reportCarProductFitment(client, environment, args.produto_id, input.moto_ano, application);
  return quoteVehicleApplication(application, async () => Boolean(args.bairro ||
    (env.ROUTING_GEO && await getLatestCustomerLocation(client, environment, conversationId))), search);
}

export async function quoteVehicleApplication(application: Application, canQuote: () => Promise<boolean>, search: MeasureSearch): Promise<string> {
  if (!application.consultas_de_produto.length) return JSON.stringify(application);
  if (!await canQuote()) return JSON.stringify({ ...application, precisa_localizacao: true,
    proximo_passo: 'Informe a medida identificada. Para cotar a oferta da loja, peça localização e use buscar_produto com a medida.' });
  const searches: Array<{ medida_pneu: string; resultado: Record<string, unknown> }> = [];
  for (const query of application.consultas_de_produto) {
    const positions = new Set(('posicoes_por_medida' in application ? application.posicoes_por_medida?.[query.medida_pneu] : undefined) ??
      application.aplicacoes.filter(row => row.display_measure === query.medida_pneu).map(row => row.position));
    const posicao_pneu = positions.size === 1 ? [...positions][0]! : 'both';
    searches.push({ medida_pneu: query.medida_pneu, resultado: await search({ ...query, posicao_pneu }) });
  }
  const city = searches.find(search => search.resultado.precisa_municipio)?.resultado;
  return JSON.stringify({ ...application, estoque_consultado: searches.every(s => !s.resultado.erro),
    consultas_estoque: searches,
    produtos: searches.flatMap(s => Array.isArray(s.resultado.produtos) ? s.resultado.produtos : []),
    ...(searches.some(s => s.resultado.precisa_localizacao) ? { precisa_localizacao: true } : {}),
    ...(searches.some(s => s.resultado.sem_estoque_loja_perto) ? { sem_estoque_loja_perto: true } : {}),
    ...(searches.some(s => s.resultado.erro) ? { falha_consulta_estoque: true } : {}),
    ...(city ? { precisa_municipio: true, municipios_possiveis: city.municipios_possiveis } : {}),
    proximo_passo: city ? 'A medida está identificada. Confirme somente o município do bairro para cotar.'
      : 'A medida está identificada. Use apenas os preços e disponibilidades de consultas_estoque, respeitando a localização. Falha de consulta não indica falta de estoque. A equipe confere a construção, os índices e a montagem do produto.' });
}
