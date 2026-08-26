import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function pdfState(selected = true) {
  const sandbox: any = { window: { PAINEL_MODULES: {} }, Uint8Array };
  vm.runInNewContext(
    readFileSync(resolve('painel/public/app.compras.reposicao.pdf.js'), 'utf8'), sandbox,
  );
  const methods = sandbox.window.PAINEL_MODULES.comprasReposicaoPdf();
  const row = {
    measure: '110/70-13', tire_condition: 'meia_vida', selected,
    quantity_available: 5, min_quantity: 8, planned_quantity: 3,
    recommended_brand: 'Pirelli', supplier_name: 'Fornecedor Teste',
    supplier_id: 'supplier-1', historical_unit_cost: 25,
  };
  return {
    ...methods,
    comprasReplenishment: { rows: [row], generatedAt: '2026-08-25T13:00:00Z' },
    comprasReplenishmentSelectedRows: () => selected ? [row] : [],
    comprasReplenishmentSummary: () => ({
      tires: 3, measures: 1, estimated: 75, savings: 12,
    }),
    comprasReplenishmentSuppliers: () => [{
      supplier_name: 'Fornecedor Teste', quantity: 3, estimated: 75,
    }],
    comprasReplenishmentCondition: () => 'Meia-vida',
    formatDateTime: () => '25/08/2026 10:00',
  } as any;
}

describe('PDF do plano de reposição', () => {
  it('gera um PDF A4 válido a partir das mesmas linhas selecionadas na tela', () => {
    const payload = pdfState().comprasReplenishmentPdfBytes() as Uint8Array;
    const binary = String.fromCharCode(...payload);

    expect(binary.startsWith('%PDF-1.4')).toBe(true);
    expect(binary).toContain('/MediaBox [0 0 842 595]');
    expect(binary).toContain('PLANO DE REPOSIÇÃO');
    expect(binary).toContain('110/70-13 / Meia-vida');
    expect(binary.endsWith('%%EOF')).toBe(true);
  });

  it('não cria relatório vazio', () => {
    expect(pdfState(false).comprasReplenishmentPdfBytes()).toBeNull();
  });
});
