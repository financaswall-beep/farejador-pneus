import type { Pool, PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { cachedReverseGeocode, reverseCacheKey } from '../../shared/geo/geo-cache.js';
import { logger } from '../../shared/logger.js';

export interface SharedLeadLocation {
  label: string; estimated_address: string | null; observed_at: string; maps_url: string;
  source: 'shared_pin' | 'typed' | 'legacy';
}
interface Candidate {
  contact_id: string; source: SharedLeadLocation['source']; observed_at: string;
  coordinates_lat: string | number | null; coordinates_lng: string | number | null;
  fact_value: unknown;
}
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const mapsUrl = (value: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`;
function point(candidate: Candidate) {
  const lat = Number(candidate.coordinates_lat), lng = Number(candidate.coordinates_lng);
  return candidate.coordinates_lat != null && candidate.coordinates_lng != null
    && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// A localização pertence ao contato: ficha, quadro e detalhe consultam o mesmo histórico.
// Campos escalares antigos são apenas fallback; nunca substituem um pino ou fato estruturado.
export const leadLocationSql = `WITH candidates AS (
  SELECT cv.contact_id, 'shared_pin'::text AS source, a.coordinates_lat, a.coordinates_lng,
         a.created_at AS observed_at, NULL::jsonb AS fact_value, 1 AS priority, a.id
    FROM core.message_attachments a
    JOIN core.conversations cv ON cv.id=a.conversation_id AND cv.environment=a.environment
   WHERE a.environment=$1 AND cv.contact_id=ANY($2::uuid[]) AND cv.deleted_at IS NULL
     AND a.file_type='location' AND a.coordinates_lat BETWEEN -90 AND 90
     AND a.coordinates_lng BETWEEN -180 AND 180
     AND EXISTS (SELECT 1 FROM core.messages m WHERE m.id=a.message_id
       AND m.environment=a.environment AND m.conversation_id=a.conversation_id
       AND m.sender_type='contact' AND m.deleted_at IS NULL AND m.is_private=false)
  UNION ALL
  SELECT cv.contact_id, 'typed', NULL::numeric, NULL::numeric,
         COALESCE(f.observed_at,f.created_at), f.fact_value, 0, f.id
    FROM analytics.conversation_facts f
    JOIN core.conversations cv ON cv.id=f.conversation_id AND cv.environment=f.environment
   WHERE f.environment=$1 AND cv.contact_id=ANY($2::uuid[]) AND cv.deleted_at IS NULL
     AND f.fact_key='localizacao_lead' AND f.superseded_by IS NULL
     AND jsonb_typeof(f.fact_value)='object'
     AND COALESCE(NULLIF(trim(f.fact_value->>'texto_informado'),''),
                  NULLIF(trim(f.fact_value->>'bairro'),''), NULLIF(trim(f.fact_value->>'municipio'),''),
                  NULLIF(trim(f.fact_value->>'rua'),'')) IS NOT NULL
  UNION ALL
  SELECT cv.contact_id, 'legacy', NULL::numeric, NULL::numeric,
         COALESCE(f.observed_at,f.created_at), f.fact_value, -1, f.id
    FROM analytics.conversation_facts f
    JOIN core.conversations cv ON cv.id=f.conversation_id AND cv.environment=f.environment
   WHERE f.environment=$1 AND cv.contact_id=ANY($2::uuid[]) AND cv.deleted_at IS NULL
     AND f.fact_key IN ('bairro_canonico','bairro_consultado','municipio_entrega')
     AND f.superseded_by IS NULL AND jsonb_typeof(f.fact_value)='string'
     AND NULLIF(trim(f.fact_value #>> '{}'),'') IS NOT NULL
)
SELECT DISTINCT ON (contact_id) contact_id::text, source, coordinates_lat, coordinates_lng,
       observed_at::text, fact_value
  FROM candidates
 ORDER BY contact_id, (source='legacy'), observed_at DESC, priority DESC, id DESC`;

export async function loadCustomerLeadLocations(
  environment: 'prod' | 'test', contactIds: string[], dbPool: Pool,
  options: { resolvePin?: boolean } = {},
): Promise<Map<string, SharedLeadLocation>> {
  const locations = new Map<string, SharedLeadLocation>();
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (!ids.length) return locations;
  try {
    const candidates = (await dbPool.query<Candidate>(leadLocationSql, [environment, ids])).rows;
    const pins = candidates.filter(c => c.source === 'shared_pin' && point(c));
    const cached = new Map<string, unknown>();
    // O quadro lê o cache em lote. Abrir 500 leads não dispara 500 chamadas ao Google.
    if (pins.length && !options.resolvePin) {
      try {
        const keys = [...new Set(pins.map(c => reverseCacheKey(point(c)!)))];
        const rows = (await dbPool.query<{ cache_key: string; value: unknown }>(
          `SELECT cache_key,value FROM commerce.geo_cache
            WHERE cache_key=ANY($1::text[]) AND created_at > now() - interval '90 days'`, [keys],
        )).rows;
        for (const row of rows) cached.set(row.cache_key, row.value);
      } catch (error) { logger.warn({ error }, 'clientes: cache de localização indisponível'); }
    }
    for (const candidate of candidates) {
      let location: SharedLeadLocation;
      if (candidate.source === 'shared_pin') {
        const coordinates = point(candidate);
        if (!coordinates) continue;
        let reverse = record(cached.get(reverseCacheKey(coordinates)));
        if (options.resolvePin) {
          try {
            reverse = record(await cachedReverseGeocode(dbPool as unknown as PoolClient,
              coordinates, env.GOOGLE_MAPS_API_KEY, { requireFormattedAddress: true }));
          } catch (error) { logger.warn({ error }, 'clientes: endereço estimado do pino indisponível'); }
        }
        const region = [clean(reverse.neighborhood), clean(reverse.municipio)].filter(Boolean).join(' — ');
        const address = clean(reverse.formattedAddress) || region || null;
        location = { source: candidate.source, observed_at: candidate.observed_at,
          label: region || address || 'Localização compartilhada', estimated_address: address,
          maps_url: mapsUrl(`${coordinates.lat},${coordinates.lng}`) };
      } else {
        const value = record(candidate.fact_value);
        const text = candidate.source === 'legacy' ? clean(candidate.fact_value) : clean(value.texto_informado);
        const address = [value.rua,value.numero,value.bairro,value.municipio].map(clean).filter(Boolean).join(', ') || text;
        const label = [value.bairro,value.municipio].map(clean).filter(Boolean).join(' — ') || address;
        if (!label) continue;
        location = { source: candidate.source, observed_at: candidate.observed_at,
          label, estimated_address: address, maps_url: mapsUrl(address) };
      }
      locations.set(candidate.contact_id, location);
    }
  } catch (error) { logger.warn({ error }, 'clientes: localização do lead indisponível'); }
  return locations;
}
