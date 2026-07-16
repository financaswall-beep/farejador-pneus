import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import type { GeoPoint } from '../shared/geo/haversine.js';
import { type GeocodeResult } from '../shared/geo/google-maps.js';
import { cachedGeocodeAddress } from '../shared/geo/geo-cache.js';
import { locationFreshnessHours } from './location-freshness.js';

/**
 * Coordenada do CLIENTE a partir do anexo de localização mais recente da
 * conversa (o pino que ele compartilhou no WhatsApp).
 *
 * Ver docs/PLANO_CAMADA_GEO_PROXIMIDADE_REDE_2026-06-06.md §5.4.
 *
 * O LLM NUNCA manipula lat/lng cru — esta função resolve server-side por
 * `conversationId`, que as tools já recebem. Escopo por conversa (não vaza
 * coordenada entre clientes — não reabre SEC-001; revisado no portão seguranca).
 *
 * `file_type='location'` é como o Chatwoot marca o pino. NUMERIC volta como
 * string do pg → `Number()`. Sem pino na conversa → `null` (chamador geocoda o
 * endereço digitado ou cai no fallback por cidade — caso F).
 *
 * `freshnessHours` (default = config `LOCATION_FRESHNESS_HOURS`): quando > 0, só
 * considera o pino mandado nas últimas N horas — mais velho é tratado como "sem
 * pino" (o bot pede a localização de novo). null/0 = sem janela (o pino vale pra
 * sempre; comportamento até 2026-07-16). O default puxa a config aqui pra que os
 * chamadores existentes (agent.ts, tools.ts) herdem a régua sem mudar assinatura.
 */
interface LocationRow {
  coordinates_lat: string | number;
  coordinates_lng: string | number;
}

export async function getLatestCustomerLocation(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  freshnessHours: number | null = locationFreshnessHours(),
): Promise<GeoPoint | null> {
  const fresh = typeof freshnessHours === 'number' && Number.isFinite(freshnessHours) && freshnessHours > 0
    ? freshnessHours
    : null;
  const params: unknown[] = [environment, conversationId];
  let freshClause = '';
  if (fresh !== null) {
    params.push(fresh);
    // make_interval(hours => N) é seguro (N é parâmetro, não interpolado).
    freshClause = '\n        AND created_at > now() - make_interval(hours => $3::int)';
  }
  const r = await client.query<LocationRow>(
    `SELECT coordinates_lat, coordinates_lng
       FROM core.message_attachments
      WHERE environment = $1
        AND conversation_id = $2
        AND file_type = 'location'
        AND coordinates_lat IS NOT NULL
        AND coordinates_lng IS NOT NULL${freshClause}
      ORDER BY created_at DESC
      LIMIT 1`,
    params,
  );

  const row = r.rows[0];
  if (!row) return null;

  const lat = Number(row.coordinates_lat);
  const lng = Number(row.coordinates_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng };
}

/**
 * location_type do Google que aceitamos como PRECISO o bastante pra rotear pela
 * CASA do cliente (nível de lote/rua):
 *  - `ROOFTOP`             → telhado, ponto exato;
 *  - `RANGE_INTERPOLATED`  → interpolado no trecho da rua pelo número.
 * `GEOMETRIC_CENTER` (centro de uma via/polígono) e `APPROXIMATE` (centro de
 * bairro/cidade) são VAGOS — não dá pra confiar que é a casa, então caímos no
 * paraquedas do bairro em vez de rotear por um ponto solto (rua homônima, número
 * inexistente). `null` (Google negou/caiu) também não é preciso.
 */
const PRECISE_LOCATION_TYPES = new Set(['ROOFTOP', 'RANGE_INTERPOLATED']);

export function isPreciseGeocode(result: GeocodeResult | null): boolean {
  return result != null && PRECISE_LOCATION_TYPES.has(result.confidence);
}

/**
 * Coordenada do CLIENTE em CAMADAS, da melhor pra pior (decisão Wallace 2026-06-10
 * — usar a Google que ele paga pra ter a precisão da rua+número, com o dicionário
 * de bairro só de paraquedas):
 *   1) PINO do WhatsApp     → ponto exato, de graça (sempre vence).
 *   2) ENDEREÇO COMPLETO    → rua+número geocodificados pela Google; só vale se o
 *      Google devolver nível de casa/rua (`isPreciseGeocode`). Senão é vago e não
 *      arriscamos rotear por ele → cai pro bairro.
 *   3) BAIRRO (paraquedas)  → centro do bairro (determinístico, comportamento de
 *      hoje), pra NUNCA ficar cego quando a Google nega/cai (a chave é restrita
 *      por IP) ou o endereço não resolve fino.
 * `null` quando não há pino, nem chave, nem endereço/bairro que resolva. O LLM
 * NUNCA toca lat/lng — resolve server-side por `conversationId` (não reabre
 * SEC-001). A `apiKey` vem por parâmetro (mantém o módulo testável sem ambiente).
 */
export async function resolveCustomerLocation(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  opts: {
    municipio: string | null;
    bairro?: string | null;
    /** Endereço completo digitado (rua+número) — existe na ENTREGA. */
    fullAddress?: string | null;
    apiKey: string | undefined;
    /** Janela do pino (default = config). O endereço/bairro digitado é da mensagem
     *  ATUAL — já é fresco por natureza; a janela só vale pro pino persistido. */
    freshnessHours?: number | null;
  },
): Promise<GeoPoint | null> {
  // 1) pino — ponto exato, de graça, sempre vence (respeitando a validade da localização).
  const freshnessHours = opts.freshnessHours !== undefined ? opts.freshnessHours : locationFreshnessHours();
  const pin = await getLatestCustomerLocation(client, environment, conversationId, freshnessHours);
  if (pin) return pin;

  const { municipio, bairro, fullAddress, apiKey } = opts;
  if (!apiKey) return null;

  // 2) endereço completo → ponto preciso da casa. Inclui bairro+cidade na busca pra
  //    ancorar o Google na região certa (evita rua homônima em outra cidade). Só
  //    confia se o location_type vier nível de casa/rua; vago → cai no paraquedas.
  if (fullAddress && fullAddress.trim()) {
    const query = [fullAddress, bairro, municipio, 'Brasil'].filter(Boolean).join(', ');
    const precise = await cachedGeocodeAddress(client, query, apiKey);
    if (isPreciseGeocode(precise)) return { lat: precise!.lat, lng: precise!.lng };
  }

  // 3) paraquedas: centro do BAIRRO (mesma busca determinística de hoje).
  if (bairro && bairro.trim()) {
    const g = await cachedGeocodeAddress(client, [bairro, municipio, 'Brasil'].filter(Boolean).join(', '), apiKey);
    if (g) return { lat: g.lat, lng: g.lng };
  }
  return null;
}
