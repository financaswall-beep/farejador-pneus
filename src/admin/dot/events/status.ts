import { env } from '../../../shared/config/env.js';
import type { DotIdentity } from '../token-store.js';
import { withDotReadOnly } from '../read-only.js';
import { activeSubscriptionsSql,subscriptionParams } from './subscriptions.js';
import { dotEventsState } from './availability.js';

export const monitorTool={name:'consultar_acompanhamento_matriz',
  description:'Consulta assinaturas ativas e contadores de eventos do acompanhamento, limites e horários. Não ativa, pausa ou envia avisos. Sem segredos ou destinos dos webhooks.',
  inputSchema:{type:'object' as const,properties:{},additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}};
export async function monitorStatus(identity:DotIdentity) {
  const state=dotEventsState();
  if(!state.enabled)return {...state,subscriptions:null,last_24h:null,
    warning:'Acompanhamento não está ativo. Corrija a configuração indicada e reinicie o serviço. As consultas comerciais continuam disponíveis. Contadores não foram consultados.'};
  return withDotReadOnly(async db=>{
    const subs=await db.query(`SELECT id,event_name,arguments,created_at,expires_at,last_delivery_at FROM (${activeSubscriptionsSql}
      AND s.person_id=$4) active`,[...subscriptionParams(),identity.person_id]);
    const deliveries=await db.query(`SELECT d.status,count(*)::int count FROM ops.dot_event_deliveries d
      JOIN network.dot_event_subscriptions s ON s.environment=d.environment AND s.id=d.subscription_id
      WHERE d.environment=$1 AND s.person_id=$2 AND d.created_at>now()-interval '24 hours' GROUP BY d.status`,
    [env.FAREJADOR_ENV,identity.person_id]);
    return {...state,subscriptions:subs.rows,last_24h:deliveries.rows,
      policy:{wait_minutes:env.DOT_EVENTS_WAIT_MINUTES,cooldown_minutes:env.DOT_EVENTS_COOLDOWN_MINUTES,
        normal_events_per_hour:env.DOT_EVENTS_MAX_PER_HOUR,quiet_start:env.DOT_EVENTS_QUIET_START_HOUR,
        quiet_end:env.DOT_EVENTS_QUIET_END_HOUR,timezone:'America/Sao_Paulo'},
      warning:'Entrega HTTP confirmada não prova análise pela Milly nem notificação ao dono. Confira o resultado no Dot. Sem monitor externo de indisponibilidade total.'};
  });
}
