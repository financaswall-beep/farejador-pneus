import { withPartnerContext } from './db.js';
import type { PartnerContext } from './auth.js';

export type PartnerPanelCanaryEvent = {
  page: 'resumo' | 'retiradas' | 'estoque';
  eventType: 'page_open' | 'read' | 'write';
  operation: 'load_summary' | 'load_pickups' | 'confirm_pickup' | 'cancel_pickup'
    | 'load_stock' | 'load_stock_detail' | 'request_stock_count' | null;
  outcome: 'success' | 'error';
  statusCode: number | null;
  durationMs: number | null;
  errorCode: string | null;
};

export async function getPartnerModernPanelEnabled(context: PartnerContext): Promise<boolean> {
  return withPartnerContext(context.partnerUnitId, async (client) => {
    const result = await client.query<{ modern_panel_enabled: boolean }>(
      `SELECT modern_panel_enabled
         FROM network.partner_units
        WHERE id=$1 AND environment=$2`,
      [context.partnerUnitId, context.environment],
    );
    return result.rows[0]?.modern_panel_enabled === true;
  });
}

/**
 * Grava somente saúde técnica. O INSERT nasce da própria linha escopada da
 * unidade e falha fechado quando o canário foi desligado.
 */
export async function recordPartnerPanelCanaryEvent(
  context: PartnerContext,
  event: PartnerPanelCanaryEvent,
): Promise<boolean> {
  return withPartnerContext(context.partnerUnitId, async (client) => {
    const result = await client.query(
      `INSERT INTO ops.partner_panel_canary_events
         (environment,partner_unit_id,panel_version,page,event_type,operation,
          outcome,status_code,duration_ms,error_code)
       SELECT pu.environment,pu.id,'modern',$3,$4,$5,$6,$7,$8,$9
         FROM network.partner_units pu
        WHERE pu.id=$1 AND pu.environment=$2 AND pu.modern_panel_enabled=true`,
      [
        context.partnerUnitId, context.environment, event.page, event.eventType,
        event.operation, event.outcome, event.statusCode, event.durationMs, event.errorCode,
      ],
    );
    return result.rowCount === 1;
  });
}
