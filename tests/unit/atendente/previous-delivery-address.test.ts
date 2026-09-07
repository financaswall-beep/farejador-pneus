import { describe,expect,it,vi } from 'vitest';
import {
  deliveryAddressHasNumber,resolveDeliveryAddress,
} from '../../../src/atendente-v2/previous-delivery-address.js';

describe('confirmação do endereço anterior',() => {
  it('exige número no endereço novo',async () => {
    const client = { query:vi.fn() };
    await expect(resolveDeliveryAddress(client as never,'test','conv','contact',{ address:'Rua das Flores, Centro' }))
      .resolves.toEqual({ ok:false,code:'numero_endereco_obrigatorio' });
    await expect(resolveDeliveryAddress(client as never,'test','conv','contact',{ address:'Rua das Flores, 123, Centro' }))
      .resolves.toEqual({ ok:true,address:'Rua das Flores, 123, Centro',source:'current_conversation' });
    expect(client.query).not.toHaveBeenCalled();
    expect(deliveryAddressHasNumber('Estrada sem número, bairro rural')).toBe(true);
  });

  it('recupera endereço quando o GPT sinaliza confirmação após resposta imediata ao bot',async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows:[
        { sender_type:'contact' },
        { sender_type:'agent_bot' },
      ] })
      .mockResolvedValueOnce({ rows:[{ delivery_address:'Rua Segura, 45, Centro' }] });
    await expect(resolveDeliveryAddress({ query } as never,'prod','conv','contact',{ usePrevious:true }))
      .resolves.toEqual({ ok:true,address:'Rua Segura, 45, Centro',source:'previous_delivery' });
    expect(String(query.mock.calls[1]?.[0])).toContain("delivery_status='delivered'");
    expect(query.mock.calls[1]?.[1]).toEqual(['prod','contact']);
  });

  it('aceita resposta ao bot registrada pelo Chatwoot como mensagem de usuário',async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows:[{ sender_type:'contact' },{ sender_type:'user' }] })
      .mockResolvedValueOnce({ rows:[{ delivery_address:'Av. Central, 3990' }] });
    await expect(resolveDeliveryAddress({ query } as never,'prod','conv','contact',{ usePrevious:true }))
      .resolves.toEqual({ ok:true,address:'Av. Central, 3990',source:'previous_delivery' });
  });

  it('não aceita a flag do modelo sem uma resposta nova logo após o bot',async () => {
    const query = vi.fn().mockResolvedValue({ rows:[
      { sender_type:'agent_bot' },
      { sender_type:'contact' },
    ] });
    await expect(resolveDeliveryAddress({ query } as never,'prod','conv','contact',{ usePrevious:true }))
      .resolves.toEqual({ ok:false,code:'confirmacao_endereco_anterior_obrigatoria' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
