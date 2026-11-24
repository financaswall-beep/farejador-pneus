import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Group {
  origin_pending: boolean;
  inspection_status: string;
  matched_set: boolean;
  quantity_on_hand: number;
  quantity_reserved: number;
}

const window = {} as { StockGroupLabels: { kind(group: Group): string } };
runInNewContext(readFileSync('painel/public/stock-group-labels.js', 'utf8'), { window });
const confirmed: Group = {
  origin_pending: false, inspection_status: 'approved', matched_set: true,
  quantity_on_hand: 2, quantity_reserved: 0,
};

describe('formação física exibida no estoque', () => {
  it('só identifica pares e conjuntos que a equipe marcou e conferiu', () => {
    const { kind } = window.StockGroupLabels;
    expect(kind(confirmed)).toBe('Par conferido');
    expect(kind({ ...confirmed, quantity_on_hand: 3 })).toBe('Conjunto conferido');
    expect(kind({ ...confirmed, matched_set: false })).toBe('Avulsos');
    expect(kind({ ...confirmed, quantity_on_hand: 1 })).toBe('Avulso');
    expect(kind({ ...confirmed, quantity_on_hand: 0 })).toBe('Sem unidades');
  });
  it('mostra o estado de conferência e distingue reserva de saída física', () => {
    const { kind } = window.StockGroupLabels;
    expect(kind({ ...confirmed, inspection_status: 'located' })).toBe('Somente localização');
    expect(kind({ ...confirmed, inspection_status: 'pending' })).toBe('Aguardando inspeção');
    expect(kind({ ...confirmed, inspection_status: 'blocked' })).toBe('Bloqueado');
    expect(kind({ ...confirmed, quantity_reserved: 2 })).toBe('Par conferido');
    expect(kind({ ...confirmed, origin_pending: true, quantity_on_hand: 1 })).toBe('Origem a conferir');
  });
});
