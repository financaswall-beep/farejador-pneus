import { describe,expect,it,vi } from 'vitest';
import { formatCustomerContext,loadCustomerContext } from '../../../src/atendente-v2/customer-context.js';

describe('contexto permanente do cadastro do cliente',() => {
  it('reconhece cliente, telefone, histórico e endereço anterior sem expor dados sensíveis',() => {
    const text = formatCustomerContext({
      name:'Ana Silva',has_phone:true,purchase_count:3,partial_ltv_brl:'899.70',
      last_purchase_at:'2026-09-01T15:00:00Z',last_purchase_item:'90/90-18',
      has_previous_delivery_address:true,
    });
    expect(text).toContain('Nome conhecido do Chatwoot: Ana');
    expect(text).toContain('Telefone já cadastrado');
    expect(text).toContain('Cliente recorrente: 3 compra(s)');
    expect(text).toContain('90/90-18');
    expect(text).toContain('mesmo endereço da última entrega');
    expect(text).toContain('usar_endereco_anterior=true');
    expect(text).not.toContain('+5521');
    expect(text).not.toContain('Rua');
  });

  it('não chama placeholder de nome e avisa quando telefone ainda precisa ser coletado',() => {
    const text = formatCustomerContext({
      name:'John Doe',has_phone:false,purchase_count:0,partial_ltv_brl:null,
      last_purchase_at:null,last_purchase_item:null,has_previous_delivery_address:false,
    });
    expect(text).toContain('Nome não confirmado');
    expect(text).toContain('Telefone ainda não cadastrado');
    expect(text).toContain('Nenhuma compra concluída');
    expect(text).not.toContain('ENDEREÇO ANTERIOR');
  });

  it('consulta cadastro e pedidos pelo contact_id exato da conversa',async () => {
    const query = vi.fn().mockResolvedValue({ rows:[] });
    await expect(loadCustomerContext({ query } as never,'conv-1')).resolves.toBeNull();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('cv.id=$1');
    expect(sql).toContain('o.contact_id=cc.contact_id');
    expect(sql).toContain("previous.delivery_status='delivered'");
    expect(sql).not.toContain('phone_e164=');
  });
});
