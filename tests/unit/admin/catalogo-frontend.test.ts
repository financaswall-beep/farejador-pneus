import { readFileSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadCatalogModule() {
  const sandbox = { window: { PAINEL_MODULES: {} }, console, setTimeout };
  vm.runInNewContext(readFileSync('painel/public/app.catalogo.js', 'utf8'), sandbox);
  return sandbox.window.PAINEL_MODULES.catalogo();
}

describe('catalogo no painel', () => {
  it('calcula preco por margem, lucro e minimo usando custo oficial', () => {
    const module = loadCatalogModule();
    const context = {
      catalogoSelecionado: { official_unit_cost: 82 },
      catalogoPriceForm: { price: '', reason: '', marginPreset: null },
      catalogoNovoPreco: module.catalogoNovoPreco,
      catalogoLucro: module.catalogoLucro,
    };

    module.catalogoApplyMargin.call(context, 40);
    expect(context.catalogoPriceForm.price).toBe('136.67');
    expect(context.catalogoPriceForm.marginPreset).toBe(40);
    expect(module.catalogoLucro.call(context)).toBeCloseTo(54.67);
    expect(module.catalogoMargem.call(context)).toBeCloseTo(40);
    expect(module.catalogoPrecoMinimo.call(context)).toBeCloseTo(126.1538);
  });

  it('nao inventa lucro sem custo e exige motivo para salvar', () => {
    const module = loadCatalogModule();
    const context = {
      catalogoSelecionado: { official_unit_cost: null },
      catalogoPriceForm: { price: '139.90', reason: '' },
      catalogoSaving: false,
      catalogoNovoPreco: module.catalogoNovoPreco,
    };

    expect(module.catalogoLucro.call(context)).toBeNull();
    expect(module.catalogoPrecoMinimo.call(context)).toBeNull();
    expect(module.catalogoPodeSalvar.call(context)).toBe(false);
    context.catalogoPriceForm.reason = 'Nova tabela';
    expect(module.catalogoPodeSalvar.call(context)).toBe(true);
  });

  it('mantem preco da venda avulsa somente leitura e expõe a tela real', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain("currentPage === 'catalogo'");
    expect(html).toContain('/admin/painel/tailwind.css?v=20260729-catalog-layout1');
    expect(html).toContain('app.catalogo.js?v=20260731-multimarca3');
    expect(html).toContain('/admin/painel/assets/catalog-tire.webp?v=20260729-catalogo1');
    expect(html).toContain('catalogoBrandLogo(brand)');
    expect(html).toContain('catalogoBrandLogo(row.brand)');
    expect(html).toContain('catalogoBrandLogo(catalogoSelecionado?.brand)');
    expect(html).toContain('data-testid="catalog-margin-presets" class="flex w-full gap-2"');
    expect(html).toContain('data-testid="catalog-margin-summary" class="flex w-full gap-2"');
    expect(html).toContain('data-testid="catalog-editor-backdrop" class="absolute inset-0 bg-gray-950/30 backdrop-blur-sm"');
    expect(html).not.toContain('catalogoBrandStyle(');
    expect(html).not.toContain('rounded-full border-[5px] border-gray-800 bg-gray-200');
    expect(html).toMatch(/x-model\.number="saleForm\.unit_price"[^>]*readonly/);
    expect(readFileSync('painel/public/app.catalogo.js', 'utf8')).toContain('/admin/api/catalog');
  });

  it('mapeia as marcas homologadas para logos locais e preserva fallback', () => {
    const module = loadCatalogModule();
    const brands = [
      'Pirelli', 'Metzeler', 'Michelin', 'Bridgestone', 'Dunlop', 'Levorin',
      'Rinaldi', 'Maggion', 'Technic', 'Vipal', 'Mitas', 'Kenda',
    ];

    for (const brand of brands) {
      expect(module.catalogoBrandLogo(brand)).toMatch(
        /^\/admin\/painel\/assets\/catalog-brands\/[a-z]+\.webp\?v=20260729-catalogo2$/,
      );
      const file = module.catalogoBrandLogo(brand).match(/catalog-brands\/([a-z]+\.webp)/)?.[1];
      if (!file) throw new Error(`Logo não mapeado: ${brand}`);
      expect(statSync(`painel/public/assets/catalog-brands/${file}`).size).toBeGreaterThan(500);
    }
    expect(module.catalogoBrandLogo('Magion')).toBe(module.catalogoBrandLogo('Maggion'));
    expect(module.catalogoBrandLogo('Marca futura')).toBeNull();
  });

  it('mantem o editor como painel lateral e compartilha as marcas com Compras e Estoque', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain('style="width:min(440px, calc(100vw - 24px));"');
    expect(html).toContain('id="catalog-brand-options"');
    expect(html).toContain('x-model="stockForm.brand"');
    expect(html).toContain('x-model="it.brand" list="catalog-brand-options"');
    expect(html).toContain(':disabled="!catalogoRows.some((row) => row.brand === brand)"');
    for (const brand of ['Pirelli', 'Michelin', 'Maggion', 'Kenda']) {
      expect(html).toContain(`<option value="${brand}"></option>`);
    }
  });
});
