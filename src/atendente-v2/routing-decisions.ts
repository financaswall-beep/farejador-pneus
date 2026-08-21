import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

type DecisionKind = 'partner' | 'matrix' | 'only_far' | 'unresolved';
type Modality = 'delivery' | 'pickup' | 'quote';
type GeoDecision =
  | { kind: 'partner'; routing: { unitId: string } }
  | { kind: 'only_far'; unitId: string }
  | { kind: 'matriz' };

export async function recordPartnerRoutingDecision(
  client: PoolClient,environment: Environment,conversationId: string,
  input: { unitId: string | null; kind: DecisionKind; municipio: string | null; modality: Modality },
): Promise<void> {
  await client.query(
    `INSERT INTO ops.partner_routing_decisions
       (environment,conversation_id,unit_id,decision_kind,municipio,modality)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (environment,conversation_id) DO UPDATE SET
       unit_id=EXCLUDED.unit_id,decision_kind=EXCLUDED.decision_kind,
       municipio=EXCLUDED.municipio,modality=EXCLUDED.modality,
       decided_at=now(),updated_at=now()`,
    [environment,conversationId,input.unitId,input.kind,input.municipio,input.modality],
  );
}

export async function recordGeoRoutingDecision(
  client: PoolClient,environment: Environment,conversationId: string,
  geo: GeoDecision,municipio: string | null,modality: Modality,
): Promise<void> {
  await recordPartnerRoutingDecision(client,environment,conversationId,{
    unitId: geo.kind === 'partner' ? geo.routing.unitId : geo.kind === 'only_far' ? geo.unitId : null,
    kind: geo.kind === 'partner' ? 'partner' : geo.kind === 'only_far' ? 'only_far' : 'matrix',
    municipio,modality,
  });
}
