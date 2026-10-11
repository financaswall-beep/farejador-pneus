import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Environment } from '../shared/types/chatwoot.js';
import type { ToolDefinition } from './types.js';
import { env } from '../shared/config/env.js';
import { readWeeklyStoreHours, weeklyStoreHoursStatus, weeklyStoreHoursText } from '../shared/weekly-store-hours.js';
import { resolveUnitCandidates, resolveUnitCandidatesByProximity, resolveDistances, resolveMunicipioFromBairro, normalizeRegion } from './fulfillment.js';
import { fillCityFromPin } from './delivery-quote-routing.js';
import { resolveCustomerLocation } from './customer-location.js';
import { readDeliverySettings } from './matriz-delivery-settings.js';

export const STORE_HOURS_TOOL: ToolDefinition = { type: 'function', function: {
  name: 'consultar_horario_loja',
  description: 'Consulta os horários semanais e calcula se a loja está aberta agora, em Brasília. Para a loja mais próxima, usa localização do cliente; sem ela, pede bairro/cidade ou pino. Use loja=matriz apenas quando o cliente mencionar explicitamente a Matriz. Não consulta nem promete estoque.',
  parameters: { type: 'object', properties: {
    loja: { type: 'string', enum: ['mais_proxima', 'matriz'] },
    bairro: { type: 'string', description: 'Somente se o cliente digitou. Omita se já enviou localização.' },
    municipio: { type: 'string', description: 'Município informado pelo cliente.' },
  }, additionalProperties: false },
} };
const schema = z.object({ loja: z.enum(['mais_proxima','matriz']).default('mais_proxima'),
  bairro: z.string().trim().max(160).optional(), municipio: z.string().trim().max(160).optional() });

function response(name: string, type: 'parceiro' | 'matriz', raw: unknown, legacy: string | null, now: Date, km?: number) {
  const hours = readWeeklyStoreHours(raw);
  return { encontrado: true, nome_loja: name, tipo_loja: type, horario_semanal: hours,
    horario: hours === null ? legacy : weeklyStoreHoursText(hours), status_agora: weeklyStoreHoursStatus(hours, now),
    ...(km == null ? {} : { distancia_km: Math.round(km * 10) / 10 }),
    orientacao: 'Responda sobre esta loja. Dias ausentes são fechados. Status desconhecido não confirma aberta agora. Horário não confirma disponibilidade de pneus.' };
}

export async function consultStoreHours(client: PoolClient, environment: Environment, conversationId: string,
  args: Record<string, unknown>, now = new Date()): Promise<Record<string, unknown>> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) return { erro: 'invalid_store_hours_location' };
  const input = parsed.data;
  const explicitMatriz = input.loja === 'matriz' ? await client.query<{ content: string | null }>(
    `SELECT content FROM core.messages WHERE environment=$1 AND conversation_id=$2
     AND message_type=0 AND sender_type='contact' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 8`,
    [environment, conversationId]) : null;
  if (explicitMatriz?.rows.some(row => /\bmatriz\b/i.test(row.content ?? ''))) {
    const saved = await readDeliverySettings(client, environment);
    return response('Matriz', 'matriz', saved?.settings.store_hours, null, now);
  }
  const city = await resolveMunicipioFromBairro(client, environment, input.bairro ?? '', input.municipio);
  const { municipio } = await fillCityFromPin(client, environment, conversationId,
    { municipio: city, neighborhoodCanonical: input.bairro ? normalizeRegion(input.bairro) : null });
  const location = await resolveCustomerLocation(client, environment, conversationId,
    { municipio, bairro: input.bairro, apiKey: env.GOOGLE_MAPS_API_KEY });
  if (!location) return { encontrado: false, precisa_localizacao: true,
    orientacao: 'Pergunte em qual bairro e cidade o cliente está, ou peça a localização. Não responda pela Matriz sem identificar a loja.' };
  const candidates = env.ROUTING_PROXIMITY_FIRST
    ? await resolveUnitCandidatesByProximity(client, environment)
    : municipio ? await resolveUnitCandidates(client, environment, municipio) : [];
  const stores = candidates.filter(store => store.serviceMode !== 'delivery' && store.location).map(store => ({
    unitId: store.ctx.unitId, location: store.location!, name: store.ctx.unitName, type: 'parceiro' as 'parceiro' | 'matriz',
  }));
  const saved = await readDeliverySettings(client, environment);
  if (saved?.settings.pickup_enabled) stores.push({ unitId: 'hours-matriz', name: 'Matriz', type: 'matriz',
    location: { lat: saved.settings.latitude, lng: saved.settings.longitude } });
  const distances = await resolveDistances(client, location, stores);
  const ranked = stores.map(store => ({ ...store, km: distances.get(store.unitId) ?? Infinity }))
    .filter(store => Number.isFinite(store.km) && store.km <= 40).sort((a, b) => a.km - b.km || a.unitId.localeCompare(b.unitId));
  const selected = ranked[0];
  if (!selected) return { encontrado: false, precisa_localizacao: false,
    orientacao: 'Não foi possível identificar uma loja próxima com os dados disponíveis. Não invente horário nem indique a Matriz por padrão.' };
  if (selected.type === 'matriz') return response('Matriz', 'matriz', saved?.settings.store_hours, null, now, selected.km);
  const result = await client.query<{ hours: unknown; legacy_text: string | null }>(
    `SELECT to_jsonb(pu)->'opening_hours_weekly' hours,pu.opening_hours_text legacy_text
     FROM network.partner_units pu WHERE pu.environment=$1 AND pu.unit_id=$2 AND pu.deleted_at IS NULL LIMIT 1`,
    [environment, selected.unitId]);
  const row = result.rows[0];
  return row ? response(selected.name, 'parceiro', row.hours, row.legacy_text, now, selected.km)
    : { encontrado: false, orientacao: 'Não foi possível confirmar o cadastro da loja. Não invente horário.' };
}
