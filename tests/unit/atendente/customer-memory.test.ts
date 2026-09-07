import { describe, expect, it, vi } from 'vitest';
import { formatCustomerMemory, loadCustomerMemory } from '../../../src/atendente-v2/customer-memory.js';

describe('memória curta do cliente', () => {
  it('formata só fatos permitidos e avisa para reconfirmar dados voláteis', () => {
    const text = formatCustomerMemory([
      { fact_key: 'moto_modelo_consultado', fact_value: 'CG 160', observed_at: new Date() },
      { fact_key: 'preco_cotado', fact_value: 289.9, observed_at: new Date() },
      { fact_key: 'endereco_entrega', fact_value: 'Rua privada, 10', observed_at: new Date() },
    ], 11);
    expect(text).toContain('últimos 11 dias');
    expect(text).toContain('moto consultada: CG 160');
    expect(text).toContain('preço cotado na época: 289.9');
    expect(text).not.toContain('Rua privada');
    expect(text).toContain('reconfirme intenção, estoque, preço, endereço e pagamento');
  });

  it('busca apenas conversas anteriores do mesmo contato dentro da janela', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(loadCustomerMemory(client as never, 'conv-atual', 11)).resolves.toBeNull();
    const sql = String(client.query.mock.calls[0]?.[0]);
    expect(sql).toContain('prior.contact_id=current.contact_id');
    expect(sql).toContain('prior.id<>$1');
    expect(sql).toContain("now()-($2*interval '1 day')");
    expect(sql).not.toContain('core.messages');
    expect(client.query.mock.calls[0]?.[1]?.[1]).toBe(11);
  });

  it('desliga sem consultar o banco quando a janela é zero', async () => {
    const client = { query: vi.fn() };
    await expect(loadCustomerMemory(client as never, 'conv', 0)).resolves.toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });
});
