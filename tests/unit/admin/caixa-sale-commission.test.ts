import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function screen() {
  const Caixa: any = { currency: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }) };
  runInNewContext(readFileSync('painel/public/caixa-sale-commission.js', 'utf8'), { window: { Caixa }, document: {} });
  return Caixa.matrixSaleCommission;
}

const sale = {
  status: 'confirmed', commission_amount: 5.45, commission_kind: 'percent', commission_value: 5,
  commission_basis: 'revenue', commission_status: 'receivable', total_amount: 109,
  commission_calculation: { active: true, itemized: false, base_amount: 109 },
};

describe('Apresentação da comissão no recibo da Matriz', () => {
  it('usa o valor do servidor, mesmo quando não coincide com uma conta local simplificada', () => {
    const data = screen().model({ ...sale, commission_amount: 6.17 });
    expect(data).toMatchObject({ amount: 6.17, label: 'A receber', rule: '5% sobre o valor da venda' });
  });

  it.each([null, undefined, '', 'indisponível'])('não troca comissão ausente (%s) por zero ou por promessa de recebimento', amount => {
    expect(screen().model({ ...sale, commission_amount: amount })).toMatchObject({
      amount: null, state: 'unknown', label: 'Não informada',
    });
  });

  it.each([
    [{ commission_status: 'paid' }, 'paid', 'Paga'],
    [{ status: 'cancelled', commission_status: 'paid' }, 'reversed', 'Cancelada'],
    [{ status: 'reserved', commission_amount: 0 }, 'pending', 'Ainda não gerada'],
    [{ commission_status: null }, 'unknown', 'Não informada'],
  ])('distingue pagamento, cancelamento, venda pendente e situação ausente', (change, state, label) => {
    expect(screen().model({ ...sale, ...change })).toMatchObject({ state, label });
  });

  it('distingue comissão zero conhecida de informação ausente', () => {
    const result = screen().model({ ...sale, commission_amount: 0, commission_kind: null,
      commission_value: 0, commission_calculation: { active: null } });
    expect(result).toMatchObject({ amount: 0, label: 'Sem comissão', rule: 'Venda sem comissão' });
  });

  it('identifica uma regra inativa sem sugerir valor a receber', () => {
    expect(screen().model({ ...sale, commission_amount: 0, commission_calculation: { active: false } }))
      .toMatchObject({ label: 'Sem comissão', rule: 'Regra de comissão inativa' });
  });

  it('explica a margem e o valor fixo sem chamar ambos de percentual sobre o total', () => {
    expect(screen().model({ ...sale, commission_basis: 'margin' }).rule).toBe('5% sobre a margem');
    expect(screen().model({ ...sale, commission_kind: 'fixed' }).rule).toBe('Valor fixo por venda');
  });

  it('não atribui o percentual legado a uma comissão calculada por tipo de item', () => {
    expect(screen().model({ ...sale, commission_calculation: { active: true, itemized: true } }))
      .toMatchObject({ itemized: true, rule: 'Regras por tipo de item' });
  });
});
