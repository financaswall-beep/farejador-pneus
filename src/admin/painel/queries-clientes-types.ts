import type { SharedLeadLocation } from './customer-lead-location.js';
import type { LeadInterest } from './customer-lead-interests.js';

export interface ClientePainelRow {
  id: string; source: 'chatwoot' | 'balcao' | 'parceiro' | 'atacado'; source_id: string;
  name: string; phone: string | null; email: string | null;
  kind: 'pessoa_fisica' | 'borracharia' | 'parceiro' | 'nao_classificado';
  is_vip: boolean; origin: string; status: 'ativo' | 'inativo';
  purchases: number; total_spent: number; avg_ticket: number; gross_profit: number;
  last_item: string | null; first_purchase_at: string | null; last_purchase_at: string | null;
  last_interaction_at: string | null; lead_stage: string | null; lead_outcome: string | null;
  lead_lane: 'novo' | 'atendimento' | 'orcamento' | 'perdido' | 'convertido' | null;
  lead_conversation_id: string | null; lead_created_at: string | null; lead_last_message_at: string | null;
  lead_waiting_on: 'equipe' | 'cliente' | 'nenhum' | null;
  lead_bot_mode?: 'auto' | 'human' | null; lead_bot_version?: number | null;
  shared_location?: SharedLeadLocation | null;
  lead_location: string | null; lead_quote_amount: number | null;
  lead_interests?: LeadInterest[];
  lead_order_amount: number | null; partner_id: string | null; partner_name: string | null;
  name_needs_review?: boolean; vip_min_purchases?: number;
  lead_derived_lane?: ClientePainelRow['lead_lane']; lead_archived?: boolean;
  lead_archive_reason?: string | null; lead_board_version?: number; lead_board_updated_at?: string | null;
  lead_manual_lane?: 'novo' | 'atendimento' | 'orcamento' | 'perdido' | null;
  chatwoot_conversation_id?: number | null; chatwoot_account_id?: number | null;
}
export interface ClienteParceiroRow {
  partner_id: string; name: string; phone: string | null; document_number: string | null;
  status: string; commercial_model: string; linked_buyer_id: string | null; purchases: number;
  total_bought: number; last_purchase_at: string | null; created_at: string;
}
