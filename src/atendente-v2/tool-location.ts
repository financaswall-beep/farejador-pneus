import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { chooseNeighborhoodCity, findNeighborhoodCandidates, normalizePlace } from './neighborhood-resolution.js';
import { fillCityFromPin } from './delivery-quote-routing.js';
import { locationFreshnessHours } from './location-freshness.js';

const LOCATION_TOOLS = new Set(['buscar_produto', 'buscar_compatibilidade', 'calcular_frete', 'localizacao_loja', 'pedir_foto', 'criar_pedido']);

/** Usa somente a última localização da mesma conversa. O município extraído
 * precisa estar escrito na mensagem original, não apenas inferido pelo LLM. */
async function rememberedCity(client: PoolClient, environment: Environment, conversationId: string, bairro: string) {
  const r = await client.query<{ municipality: string | null; neighborhood: string | null; content: string | null }>(
    `SELECT f.fact_value->>'municipio' AS municipality,f.fact_value->>'bairro' AS neighborhood,m.content
       FROM analytics.conversation_facts f
       JOIN core.messages m ON m.id=f.message_id AND m.environment=f.environment AND m.conversation_id=f.conversation_id
      WHERE f.environment=$1 AND f.conversation_id=$2 AND f.fact_key='localizacao_lead'
        AND f.superseded_by IS NULL AND m.message_type=0 AND m.sender_type='contact'
        AND ($3::int IS NULL OR COALESCE(f.observed_at,f.created_at)>now()-make_interval(hours=>$3::int))
      ORDER BY COALESCE(f.observed_at,f.created_at) DESC,f.created_at DESC,f.id DESC LIMIT 1`,
    [environment, conversationId, locationFreshnessHours()],
  );
  const latest = r.rows[0];
  if (!latest?.municipality?.trim() || !latest.content) return null;
  if (latest.neighborhood && normalizePlace(latest.neighborhood) !== normalizePlace(bairro)) return null;
  const words = normalizePlace(latest.content).replace(/[^a-z0-9]+/g, ' ');
  const city = normalizePlace(latest.municipality).replace(/[^a-z0-9]+/g, ' ');
  return ` ${words} `.includes(` ${city} `) ? latest.municipality : null;
}

/** Interrompe antes de ler estoque/frete ou gravar um pedido. Cidade já passada
 * pela ferramenta é preservada; sem ela, pino/contexto resolvem homônimos. */
export async function prepareToolLocation(
  client: PoolClient, environment: Environment, conversationId: string, tool: string, args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!LOCATION_TOOLS.has(tool)) return args;
  const bairro = typeof args.bairro === 'string' ? args.bairro.trim() : '';
  const municipio = typeof args.municipio === 'string' ? args.municipio.trim() : '';
  if (!bairro || municipio) return args;
  const candidates = await findNeighborhoodCandidates(client, environment, bairro);
  const cities = new Map(candidates.map(row => [normalizePlace(row.city_name), row.city_name]));
  if (cities.size > 1) {
    // Pino verificado vale também acima de uma preferência regional (Rio do Ouro).
    const pin = await fillCityFromPin(client, environment, conversationId, { municipio: null, neighborhoodCanonical: null });
    if (pin.municipio) return { ...args, municipio: pin.municipio,
      bairro: cities.has(normalizePlace(pin.municipio)) ? bairro : (pin.neighborhoodCanonical ?? undefined) };
    const remembered = await rememberedCity(client, environment, conversationId, bairro);
    if (remembered && cities.has(normalizePlace(remembered))) return { ...args, municipio: cities.get(normalizePlace(remembered)) };
    // criar_pedido pode reutilizar a localização resolvida na cotação anterior.
    if (tool === 'criar_pedido' && typeof args.geo_resolution_id === 'string') {
      const geo = await client.query<{ city_name: string }>(
        'SELECT city_name FROM commerce.geo_resolutions WHERE environment=$1 AND id=$2',
        [environment, args.geo_resolution_id],
      );
      const name = geo.rows[0]?.city_name;
      if (name && cities.has(normalizePlace(name))) return { ...args, municipio: name };
    }
  }
  const city = chooseNeighborhoodCity(bairro, candidates);
  return city ? { ...args, municipio: city } : args;
}
