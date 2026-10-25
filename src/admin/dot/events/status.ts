import { env } from '../../../shared/config/env.js';
import type { DotIdentity } from '../token-store.js';
import { withDotReadOnly } from '../read-only.js';
import { activeSubscriptionsSql,subscriptionParams } from './subscriptions.js';
import { dotEventsState } from './availability.js';
import { readSettings,ruleLabels } from './settings.js';
import { signalSourceStatus } from './signals.js';

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
    const config=await readSettings(db);
    const external=(await db.query('SELECT status,consecutive_failures,last_checked_at FROM ops.dot_external_health WHERE environment=$1',[env.FAREJADOR_ENV])).rows[0]??null;
    return {...state,subscriptions:subs.rows,last_24h:deliveries.rows,settings:config,source_checks:signalSourceStatus(),external_monitor:external,
      policy:{wait_minutes:config.settings.wait_minutes,cooldown_minutes:config.settings.cooldown_minutes,
        normal_events_per_hour:config.settings.max_per_hour,limit_scope:'owner_all_subscriptions',quiet_start:config.settings.quiet_start,
        quiet_end:config.settings.quiet_end,timezone:'America/Sao_Paulo',rules:ruleLabels},
      warning:'Entrega HTTP confirmada não prova análise pela Milly nem notificação ao dono. Confira o resultado no Dot. '
        +(external?'Confira a data da última verificação externa; um registro antigo não confirma monitor ativo.':'Monitor externo ainda sem verificação registrada.')};
  });
}
