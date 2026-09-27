import { describe, it, expect, vi } from 'vitest';
import { resolveOrderPhone } from '../../../src/atendente-v2/order-phone.js';

describe('telefone obrigatório no fechamento', () => {
  it('reaproveita um telefone válido do cadastro sem consultar mensagens', async () => {
    const query = vi.fn();
    expect(await resolveOrderPhone({ query } as never, 'test', 'conv', '+5521999991111', undefined)).toBe('+5521999991111');
    expect(query).not.toHaveBeenCalled();
  });
  it.each([undefined, '', '2198765565', '+552198765565'])('recusa contato sem telefone e argumento %s', async supplied => {
    expect(await resolveOrderPhone({ query: vi.fn() } as never, 'test', 'conv', null, supplied)).toBeNull();
  });
  it('não aceita um dígito inventado pelo modelo', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ content: 'Rua Exemplo 38 2198765565 vou pagar no pix' }] });
    expect(await resolveOrderPhone({ query } as never, 'test', 'conv', null, '21998765565')).toBeNull();
  });
  it('aceita o telefone completo escrito pelo cliente e restringe a consulta à conversa e ambiente', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ content: 'meu whats é (21) 99999-1111' }] });
    expect(await resolveOrderPhone({ query } as never, 'test', 'conv', null, '21999991111')).toBe('+5521999991111');
    const [sql, params] = query.mock.calls[0]!;
    expect(params).toEqual(['test', 'conv']);
    expect(sql).toContain("sender_type='contact'");
    expect(sql).toContain('environment=$1 AND conversation_id=$2');
    expect(sql).toContain('NOT is_private AND deleted_at IS NULL');
  });
  it('não ignora uma correção inválida voltando silenciosamente ao número antigo', async () => {
    expect(await resolveOrderPhone({ query: vi.fn() } as never, 'test', 'conv', '+5521999991111', '2198765565')).toBeNull();
  });
});
