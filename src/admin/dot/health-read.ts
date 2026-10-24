import { env } from '../../shared/config/env.js';
import { readOverviewAttention } from '../painel/matriz-overview-operations.js';
import { getBotResilienceCounts } from '../painel/queries-bot-resilience.js';
import { readDotFinance } from './finance-read.js';
import { rejectFilters,type DotReadContext } from './read-model.js';

export async function readDotHealth(ctx:DotReadContext) {
  rejectFilters(ctx,'referencia','medida');
  const raw=await ctx.db.query(`SELECT processing_status,count(*)::int count,max(received_at) last_received_at,
    min(received_at) oldest_received_at FROM raw.raw_events WHERE environment=$1 GROUP BY processing_status`,[env.FAREJADOR_ENV]);
  const ledger=await ctx.db.query(`SELECT checked_on,checked_at,status,error_signals,pending_signals
    FROM ops.matriz_ledger_health_checks WHERE environment=$1`,[env.FAREJADOR_ENV]);
  const sync=await ctx.db.query(`SELECT status,started_at,finished_at,rows_upserted FROM marketing.meta_sync_runs
    WHERE environment=$1 ORDER BY started_at DESC,id DESC LIMIT 1`,[env.FAREJADOR_ENV]);
  return {as_of:new Date().toISOString(),ingestion:raw.rows,ledger_check:ledger.rows[0]??null,
    bot:await getBotResilienceCounts(env.FAREJADOR_ENV,ctx.db),last_meta_sync:sync.rows[0]??null,
    warning:'Estado registrado no banco. Ausência de eventos recentes pode ser falta de tráfego; não prova queda. Sem logs, payloads ou credenciais. Checagem financeira diária pode estar desatualizada.'};
}
export async function readDotNotifications(ctx:DotReadContext) {
  rejectFilters(ctx,'referencia','medida');
  const attention=await readOverviewAttention(ctx.db,env.FAREJADOR_ENV);
  const failures=await ctx.db.query(`SELECT
    (SELECT count(*)::int FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment
      AND u.slug='main' WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.status<>'cancelled'
        AND o.fulfillment_mode='delivery' AND o.delivery_status='failed') failed_deliveries,
    (SELECT count(*)::int FROM commerce.matriz_trip_receipts WHERE environment=$1
      AND workflow_status IN ('uploaded','processing','review_required')) receipts_pending`,[env.FAREJADOR_ENV]);
  const finance=await readDotFinance(ctx.db,ctx.period.month);
  return {as_of:new Date().toISOString(),attention,...failures.rows[0],
    bot:await getBotResilienceCounts(env.FAREJADOR_ENV,ctx.db),
    finance:finance.available?{available:true,receivable:finance.receivable,payable:finance.payable,
      reconciliation:finance.reconciliation}:{available:false,reason:finance.reason},
    warning:'Consulta das pendências atuais. Não marca avisos como lidos, não envia notificações nem configura acompanhamento. Alarmes locais do navegador não estão disponíveis pela API.'};
}
