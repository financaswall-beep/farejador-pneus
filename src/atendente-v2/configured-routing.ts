import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { decideStoreForItemsGeo as originalDecision,type GeoDecisionInput,type GeoStoreDecision } from './fulfillment.js';
import { readDeliverySettings,type DeliverySettings,type DeliveryBlock } from './matriz-delivery-settings.js';
import { evaluateMatrizDelivery } from './matriz-delivery-eligibility.js';

export type ConfiguredDecision=GeoStoreDecision & { blockReason?:DeliveryBlock };
/** Mesmo ranking/estoque/anel do motor. Apenas restringe a Matriz conforme o cadastro. */
export async function decideConfiguredStore(client:PoolClient,environment:Environment,input:GeoDecisionInput,
  override?:DeliverySettings|null):Promise<ConfiguredDecision> {
  const settings=override===undefined ? (await readDeliverySettings(client,environment))?.settings??null : override;
  if (!settings) return originalDecision(client,environment,input);
  const matrix=await evaluateMatrizDelivery(client,environment,{...input,settings});
  const decision=await originalDecision(client,environment,{...input,
    matrizPolicy:{canFulfill:matrix.canFulfill&&!matrix.block,location:matrix.origin}});
  if (decision.kind!=='matriz') return decision;
  if (matrix.block) return {...decision,canFulfill:false,blockReason:matrix.block};
  if (!matrix.canFulfill) return {...decision,canFulfill:false,blockReason:'insufficient_stock'};
  return {...decision,canFulfill:true};
}
