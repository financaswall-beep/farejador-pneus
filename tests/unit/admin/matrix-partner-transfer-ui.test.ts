import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
const app = readFileSync(resolve('painel/public/app.atacado.transfer.js'), 'utf8');
const receipt = readFileSync(resolve('painel/public/caixa-stock-receipts.js'), 'utf8');

describe('interface da transferência Matriz → parceiro', () => {
  it('permite escolher a unidade e abrir acréscimo vinculado', () => {
    expect(html).toContain('Unidade parceira que receberá');
    expect(html).toContain('Adicionar pneus');
    expect(html).toContain('Registrar acréscimo');
    expect(app).toContain('atacadoStartAddition(v)');
    expect(app).toContain('body.parent_order_id = f.parent_order_id');
    expect(app).toContain('body.partner_unit_id = unitId');
  });

  it('obriga o recebimento exato depois do acerto da Matriz', () => {
    expect(receipt).toContain('matrix_linked');
    expect(receipt).toContain('item.expected_quantity');
    expect(receipt).toContain('matrix_shipment_requires_arrival_adjustment');
    expect(html).toContain('Acertar pneu por pneu');
    expect(html).toContain('À vista será confirmado somente depois do acerto');
    expect(html).toContain('Pendente · em trânsito');
    expect(app).toContain('cargo_additions');
    expect(app).toContain('será confirmado no acerto da chegada');
  });
});
