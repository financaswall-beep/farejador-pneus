import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import type { GeoPoint } from '../shared/geo/haversine.js';

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
 */
interface LocationRow {
  coordinates_lat: string | number;
  coordinates_lng: string | number;
}

export async function getLatestCustomerLocation(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
): Promise<GeoPoint | null> {
  const r = await client.query<LocationRow>(
    `SELECT coordinates_lat, coordinates_lng
       FROM core.message_attachments
      WHERE environment = $1
        AND conversation_id = $2
        AND file_type = 'location'
        AND coordinates_lat IS NOT NULL
        AND coordinates_lng IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [environment, conversationId],
  );

  const row = r.rows[0];
  if (!row) return null;

  const lat = Number(row.coordinates_lat);
  const lng = Number(row.coordinates_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng };
}
