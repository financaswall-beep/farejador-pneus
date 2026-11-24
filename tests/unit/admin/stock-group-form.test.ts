import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function warehouse(patterns: Array<string | null> = []) {
  const sandbox = { window: { PAINEL_MODULES: {} } };
  runInNewContext(readFileSync('painel/public/app.galpao.grupos.js', 'utf8'), sandbox);
  const app = (sandbox.window.PAINEL_MODULES as any).galpaoGrupos();
  app.stockGroups.stockId = 'estoque';
  app.stockGroups.stock = patterns.map((pattern, i) => ({
    stock_id: 'estoque', product_id: String(i + 1), tread_pattern: pattern,
  }));
  return app;
}

describe('cadastro de posições no galpão', () => {
  it('preenche o modelo do único produto e mantém campos legados opcionais', () => {
    for (const [pattern, model] of [[' Primacy 4 ', 'Primacy 4'], [null, ''], ['x'.repeat(121), '']]) {
      const app = warehouse([pattern]);
      app.sgNew();
      expect(app.stockGroups.form).toMatchObject({ product_id: '1', model, matched_set: false, inspection_status: 'located' });
    }
  });
  it('acompanha as trocas de produto somente enquanto o modelo não foi editado', () => {
    const app = warehouse(['Primacy 4', 'Pilot Sport', null]);
    app.sgNew();
    expect(app.stockGroups.form).toMatchObject({ product_id: '', model: '' });
    for (const [product, model] of [['2', 'Pilot Sport'], ['1', 'Primacy 4'], ['3', '']]) {
      app.sgUseCatalogModel(product);
      expect(app.stockGroups.form.model).toBe(model);
    }
    app.stockGroups.form.model = 'Informado no galpão';
    app.stockGroups.form.modelEdited = true;
    app.sgUseCatalogModel('1');
    expect(app.stockGroups.form.model).toBe('Informado no galpão');
    app.stockGroups.form.model = '';
    app.sgUseCatalogModel('2');
    expect(app.stockGroups.form.model).toBe('');
  });
  it('preserva o registro histórico ao editar um grupo de produto com modelo cadastrado', () => {
    const app = warehouse(['Primacy 4']);
    for (const model of ['Nome anterior', null]) {
      app.sgEdit({ group_id: 'antigo', product_id: '1', model });
      app.sgUseCatalogModel('1');
      expect(app.stockGroups.form.model).toBe(model ?? '');
    }
  });
  it('mantém grupos distintos na mesma pilha, várias posições de um grupo e os grupos esgotados', () => {
    const app = warehouse();
    app.stockGroups.groups = [
      { stock_id: 'estoque', group_id: 'par', positions: [{ location_code: 'C10' }, { location_code: 'C2' }] },
      { stock_id: 'estoque', group_id: 'avulso', positions: [{ location_code: 'C2' }] },
      { stock_id: 'estoque', group_id: 'esgotado', positions: [] },
      { stock_id: 'outro', group_id: 'fora', positions: [{ location_code: 'A1' }] },
    ];
    const rows = app.sgPositionRows();
    expect(rows.map((row: { key: string }) => row.key)).toEqual(['par/C2', 'avulso/C2', 'par/C10', 'esgotado/']);
    expect(rows[3].position).toBeNull();
  });
});
