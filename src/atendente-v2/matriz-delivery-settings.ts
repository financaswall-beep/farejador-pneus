import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import type { GeoPoint } from '../shared/geo/haversine.js';
import { MATRIZ_COORD, MATRIZ_MAX_DELIVERY_KM, DEFAULT_MATRIZ_FREIGHT } from './matriz-freight.js';
import type { PoliticaComercial } from '../atendente/tools/commerce-tools.js';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const freightPrice = z.number().min(0).max(10000).multipleOf(0.01);
const freightLimit = z.number().positive().max(MATRIZ_MAX_DELIVERY_KM);
const freightSchema = z.object({
  first_limit_km:freightLimit, first_price_brl:freightPrice,
  second_limit_km:freightLimit, second_price_brl:freightPrice, above_price_brl:freightPrice,
}).strict().refine(v=>v.second_limit_km>v.first_limit_km,{
  path:['second_limit_km'],message:'A segunda faixa deve terminar depois da primeira.',
});
export const deliverySettingsSchema = z.object({
  delivery_enabled: z.boolean(), pickup_enabled: z.boolean(),
  radius_km: z.number().positive().max(MATRIZ_MAX_DELIVERY_KM).nullable(),
  // Configurações já salvas continuam cobrando os mesmos valores até uma edição explícita.
  freight: freightSchema.default({...DEFAULT_MATRIZ_FREIGHT}),
  address: z.string().trim().min(3).max(350),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  days: z.array(z.number().int().min(0).max(6)).max(7),
  opens_at: clock.nullable(), closes_at: clock.nullable(),
  delivery_days: z.number().int().min(0).max(30).nullable(),
}).strict().superRefine((v, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code:'custom', path:[path], message });
  if (v.delivery_enabled && v.radius_km == null) issue('radius_km','Informe o limite de entrega.');
  if (new Set(v.days).size !== v.days.length) issue('days','Dias repetidos.');
  if ((v.opens_at == null) !== (v.closes_at == null)) issue('closes_at','Preencha início e fim do horário.');
  if (v.opens_at && v.closes_at && v.opens_at >= v.closes_at) issue('closes_at','O fim deve ser posterior ao início.');
  if ((v.opens_at || v.delivery_days != null) && !v.days.length) issue('days','Selecione os dias de entrega.');
});
export type DeliverySettings = z.infer<typeof deliverySettingsSchema>;
export interface SavedDeliverySettings { settings:DeliverySettings; version:number; updated_at:string; }
export type DeliveryBlock = 'delivery_paused'|'pickup_disabled'|'needs_location'|'outside_radius'|'insufficient_stock';

/** Ausência de cadastro preserva a configuração anterior; nunca semeia o exemplo da imagem. */
export async function readDeliverySettings(client:Pick<PoolClient,'query'>, environment:Environment):Promise<SavedDeliverySettings|null> {
  const result = await client.query<{ settings:unknown; version:number; updated_at:Date|string }>(
    'SELECT settings,version,updated_at FROM commerce.matriz_delivery_settings WHERE environment=$1',[environment]);
  const row = result.rows[0];
  if (!row?.settings) return null;
  return { settings:deliverySettingsSchema.parse(row.settings),version:row.version,
    updated_at:new Date(row.updated_at).toISOString() };
}
export function matrizOrigin(settings:DeliverySettings|null):GeoPoint {
  return settings ? { lat:settings.latitude,lng:settings.longitude } : MATRIZ_COORD;
}
export function matrizCoverageBlock(settings:DeliverySettings|null, modalidade:'delivery'|'pickup', distance:number|null):DeliveryBlock|null {
  if (!settings) return null;
  if (modalidade==='pickup') return settings.pickup_enabled ? null : 'pickup_disabled';
  if (!settings.delivery_enabled) return 'delivery_paused';
  if (distance==null || !Number.isFinite(distance)) return 'needs_location';
  if (settings.radius_km==null || distance>settings.radius_km) return 'outside_radius';
  return null;
}
export function deliveryBlockResponse(reason:DeliveryBlock) {
  const messages:Record<DeliveryBlock,string> = {
    delivery_paused:'A entrega da Matriz está pausada. Ofereça retirada se disponível; não confirme entrega.',
    pickup_disabled:'A retirada na Matriz está desabilitada. Consulte uma alternativa antes de fechar.',
    needs_location:'Não foi possível confirmar a distância. Peça a localização ou o endereço completo antes de oferecer entrega.',
    outside_radius:'O endereço está fora do limite da Matriz e não há parceiro apto nesta decisão. Consulte retirada; não confirme entrega.',
    insufficient_stock:'Nenhuma loja selecionada consegue atender o pedido completo. Informe a falta e consulte alternativas; não feche o pedido.',
  };
  return { encontrado:false,disponivel:false,erro:reason,motivo:reason,
    precisa_localizacao:reason==='needs_location',mensagem:messages[reason],orientacao:messages[reason] };
}
export function matrizScheduleText(settings:DeliverySettings):string {
  const labels=['dom','seg','ter','qua','qui','sex','sáb'];
  const days=settings.days.map(d=>labels[d]).join(', ');
  const hours=settings.opens_at ? `, das ${settings.opens_at} às ${settings.closes_at}` : '';
  const prazo=settings.delivery_days==null ? 'Prazo não cadastrado: confirmar antes de prometer.'
    : settings.delivery_days===0 ? 'Prazo: no próximo dia de entrega disponível.'
      : `Prazo: até ${settings.delivery_days} dia(s) de operação de entrega, nos dias cadastrados.`;
  return `Somente para entregas da Matriz: ${settings.delivery_enabled ? 'habilitadas' : 'pausadas'}. ${days ? `Dias: ${days}${hours}.` : 'Dias e horários não cadastrados.'} ${prazo} Não aplicar esse prazo aos parceiros nem prometer entrega imediata fora da janela.`;
}

/** Substitui somente as políticas da Matriz que este cadastro passa a administrar. */
export function applyMatrizDeliveryPolicies(policies:PoliticaComercial[],saved:SavedDeliverySettings):PoliticaComercial[] {
  const s=saved.settings;
  const managed:Record<string,string>={endereco:s.address,
    link_maps:`https://www.google.com/maps/search/?api=1&query=${s.latitude},${s.longitude}`,
    prazo_entrega_descricao:matrizScheduleText(s),
    area_entrega:`Matriz: ${s.delivery_enabled?`até ${s.radius_km} km da loja, após calcular_frete confirmar localização e estoque`:'entregas pausadas'}. Retirada na Matriz: ${s.pickup_enabled?'habilitada':'desabilitada'}. Parceiros seguem sua própria cobertura.`,
  };
  return [...policies.filter(p=>!(p.policy_key in managed)&&p.policy_key!=='rotas_hoje'),
    ...Object.entries(managed).map(([policy_key,policy_value])=>({policy_key,policy_value,
      description:'Configuração vigente da Matriz; não aplicar aos parceiros.',policy_version:`matriz-delivery-${saved.version}`}))];
}
