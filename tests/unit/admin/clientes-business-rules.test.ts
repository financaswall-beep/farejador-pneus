import { describe, expect, it } from 'vitest';
import { applyClienteBusinessRules } from '../../../src/admin/painel/queries-clientes-board.js';
import type { ClientePainelRow } from '../../../src/admin/painel/queries-clientes.js';

function row(overrides: Partial<ClientePainelRow>): ClientePainelRow {
  return {
    id:'chatwoot:1',source:'chatwoot',source_id:'1',name:'John Doe',phone:null,email:null,
    kind:'nao_classificado',is_vip:false,origin:'facebook',status:'ativo',purchases:3,
    total_spent:300,avg_ticket:100,gross_profit:0,last_item:null,first_purchase_at:null,
    last_purchase_at:null,last_interaction_at:null,lead_stage:null,lead_outcome:null,
    lead_lane:'novo',lead_conversation_id:'00000000-0000-4000-8000-000000000001',
    lead_created_at:null,lead_last_message_at:null,lead_waiting_on:'equipe',lead_location:null,
    lead_quote_amount:null,lead_order_amount:null,partner_id:null,partner_name:null,...overrides,
  };
}

describe('regras unificadas de Clientes', () => {
  it('aplica VIP com 3 compras, esconde placeholder e sobrepoe a coluna manual', () => {
    const [result] = applyClienteBusinessRules([row({})],[{
      conversation_id:'00000000-0000-4000-8000-000000000001',manual_lane:'orcamento',
      archived_at:'2026-08-21T00:00:00Z',archive_reason:'antigo',version:2,
      updated_at:'2026-08-21T00:00:00Z',
    }]);
    expect(result).toMatchObject({
      name:'Cliente sem nome',name_needs_review:true,is_vip:true,vip_min_purchases:3,
      lead_derived_lane:'novo',lead_lane:'orcamento',lead_archived:true,lead_board_version:2,
    });
  });

  it('nao permite que uma coluna manual esconda a verdade de uma venda convertida', () => {
    const [result] = applyClienteBusinessRules([row({ lead_lane:'convertido' })],[{
      conversation_id:'00000000-0000-4000-8000-000000000001',manual_lane:'perdido',
      archived_at:null,archive_reason:null,version:1,updated_at:'2026-08-21T00:00:00Z',
    }]);
    expect(result?.lead_lane).toBe('convertido');
  });
});
