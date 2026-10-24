import { readPage, rejectFilters, type DotReadContext } from './read-model.js';
import { classificationValueSql } from './safe-values.js';
import { dotChatwootAccount } from './chat-scope.js';

export async function readDotCustomers(ctx:DotReadContext,view:'compras'|'etapas'|'oportunidades') {
  rejectFilters(ctx,'medida');
  const account=view==='compras'?null:await dotChatwootAccount(ctx.db);
  if(view!=='compras'&&!account)return {available:false,reason:'chatwoot_account_not_configured_or_ambiguous'};
  if(view==='etapas')return readPage(ctx,`SELECT cc.dimension||':'||${classificationValueSql} AS id,cc.dimension,
    ${classificationValueSql} value,count(*)::int conversations
    FROM analytics.current_classifications cc JOIN core.conversations c
      ON c.environment=cc.environment AND c.id=cc.conversation_id AND c.deleted_at IS NULL
    WHERE cc.environment=$1 AND c.chatwoot_account_id=${account??0}
      AND cc.dimension IN ('stage_reached','final_outcome','loss_reason')
      AND (c.started_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR c.id=$4) AND $5='' GROUP BY cc.dimension,${classificationValueSql}`,'conversations DESC,id',
  'Etapas analíticas do atendimento da Rede, sem conteúdo de mensagens ou cadastros pessoais.');
  if(view==='oportunidades')return readPage(ctx,`SELECT c.id,c.current_status,c.started_at,c.last_activity_at,
    round(extract(epoch FROM (now()-m.sent_at))/3600,1) hours_without_reply,
    b.manual_lane FROM core.conversations c JOIN LATERAL (SELECT sender_type,sent_at FROM core.messages
      WHERE environment=c.environment AND conversation_id=c.id AND NOT is_private AND deleted_at IS NULL
      ORDER BY sent_at DESC,id DESC LIMIT 1) m ON true
    LEFT JOIN ops.customer_lead_board_state b ON b.environment=c.environment AND b.conversation_id=c.id
    WHERE c.environment=$1 AND c.chatwoot_account_id=${account??0} AND c.deleted_at IS NULL AND c.current_status<>'resolved'
      AND m.sender_type IN ('user','agent_bot') AND m.sent_at<now()-interval '1 hour'
      AND (c.last_activity_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND b.archived_at IS NULL AND b.manual_lane IS DISTINCT FROM 'perdido'
      AND EXISTS(SELECT 1 FROM analytics.conversation_facts f WHERE f.environment=c.environment
        AND f.conversation_id=c.id AND f.fact_key='preco_cotado' AND f.superseded_by IS NULL)
      AND NOT EXISTS(SELECT 1 FROM commerce.orders o WHERE o.environment=c.environment AND o.source_conversation_id=c.id)
      AND ($4::uuid IS NULL OR c.id=$4) AND $5=''`,'hours_without_reply DESC,id',
  'Oportunidades por código da conversa: orçamento sem pedido e sem resposta há mais de uma hora. Não envia mensagens.');
  return readPage(ctx,`SELECT COALESCE(o.customer_id,o.contact_id) AS id,
    count(*)::int purchases,sum(o.total_amount)::text revenue_brl,max(o.created_at) last_order_at,
    count(*)>1 repeat_buyer FROM commerce.orders o JOIN core.units u
      ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
    WHERE o.environment=$1 AND o.partner_order_id IS NULL AND COALESCE(o.customer_id,o.contact_id) IS NOT NULL
      AND o.status IN ('confirmed','paid','delivered')
      AND (o.fulfillment_mode<>'delivery' OR o.delivery_status='delivered')
      AND (CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at ELSE o.created_at END
        AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR COALESCE(o.customer_id,o.contact_id)=$4) AND $5=''
    GROUP BY COALESCE(o.customer_id,o.contact_id)`,'revenue_brl::numeric DESC,id',
  'Histórico de compras realizadas na Matriz, por código do cliente e no período. Sem deduzir identidade entre cadastros diferentes.');
}
