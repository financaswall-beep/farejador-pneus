import type { Pool } from 'pg';
import { isPlaceholderCustomerName, safeCustomerDisplayName } from '../../shared/customer-name.js';
import type { ClientePainelRow } from './queries-clientes.js';

export const VIP_MIN_PURCHASES = 3;

interface LeadBoardState {
  conversation_id: string;
  manual_lane: 'novo' | 'atendimento' | 'orcamento' | 'perdido' | null;
  archived_at: string | null;
  archive_reason: string | null;
  version: number;
  updated_at: string;
}

export async function getClienteLeadBoardStates(
  environment: 'prod' | 'test',
  dbPool: Pool,
): Promise<LeadBoardState[]> {
  const result = await dbPool.query<LeadBoardState>(
    `SELECT conversation_id::text,manual_lane,archived_at::text,archive_reason,
            version,updated_at::text
       FROM ops.customer_lead_board_state
      WHERE environment=$1`,
    [environment],
  );
  return result.rows;
}

export function applyClienteBusinessRules(
  rows: ClientePainelRow[],
  states: LeadBoardState[],
): ClientePainelRow[] {
  const byConversation = new Map(states.map((state) => [state.conversation_id, state]));
  return rows.map((row) => {
    const state = row.lead_conversation_id ? byConversation.get(row.lead_conversation_id) : undefined;
    const display = row.source === 'chatwoot'
      ? safeCustomerDisplayName(row.name)
      : { name: row.name, needs_review: isPlaceholderCustomerName(row.name) };
    const derivedLane = row.lead_lane;
    return {
      ...row,
      name: display.name,
      name_needs_review: display.needs_review,
      is_vip: Number(row.purchases || 0) >= VIP_MIN_PURCHASES,
      vip_min_purchases: VIP_MIN_PURCHASES,
      lead_derived_lane: derivedLane,
      lead_manual_lane: state?.manual_lane ?? null,
      lead_lane: derivedLane === 'convertido' ? 'convertido' : (state?.manual_lane ?? derivedLane),
      lead_archived: state?.archived_at != null,
      lead_archive_reason: state?.archive_reason ?? null,
      lead_board_version: Number(state?.version ?? 0),
      lead_board_updated_at: state?.updated_at ?? null,
    };
  });
}
