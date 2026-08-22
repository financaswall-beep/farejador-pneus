import { readFileSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadCatalogModule() {
  const integrity = {
    operation: vi.fn(() => ({ key: 'brand-correction-key' })),
    complete: vi.fn(),
  };
  const sandbox = {
    window: { PAINEL_MODULES: {}, PAINEL_INTEGRITY: integrity },
    console,
    setTimeout,
  };
  vm.runInNewContext(readFileSync('painel/public/app.catalogo.js', 'utf8'), sandbox);
  vm.runInNewContext(
    readFileSync('painel/public/app.catalogo.compatibilidade.js', 'utf8'),
    sandbox,
  );
  vm.runInNewContext(readFileSync('painel/public/app.catalogo.marca.js', 'utf8'), sandbox);
  return {
    ...sandbox.window.PAINEL_MODULES.catalogo(),
    ...sandbox.window.PAINEL_MODULES.catalogoCompatibilidade(),
    ...sandbox.window.PAINEL_MODULES.catalogoMarca(),
    __integrity: integrity,
  };
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
      adminUser: { role: 'owner' },
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
    context.catalogoPriceForm.price = '139.999';
    expect(module.catalogoPodeSalvar.call(context)).toBe(false);
  });

  it('arredonda custo fracionário ao centavo antes de calcular lucro e margem', () => {
    const module = loadCatalogModule();
    const context = {
      catalogoSelecionado: { official_unit_cost: 82.125 },
      catalogoPriceForm: { price: '139.90', reason: '' },
      catalogoNovoPreco: module.catalogoNovoPreco,
      catalogoLucro: module.catalogoLucro,
    };
    expect(module.catalogoLucro.call(context)).toBeCloseTo(57.77);
    expect(module.catalogoMargem.call(context)).toBeCloseTo((57.77 / 139.9) * 100);
  });

  it('mantem preco da venda avulsa somente leitura e expõe a tela real', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain("currentPage === 'catalogo'");
    expect(html).toContain('/admin/painel/tailwind.css?v=20260822-bot-compact2');
    expect(html).toContain('app.catalogo.js?v=20260822-continuity1');
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

  it('abre o cadastro somente para variante de estoque e segue para definir preco', async () => {
    const module = loadCatalogModule();
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      catalogoCadastro: {
        open: false, row: null, form: { product_code: '', product_name: '' },
        saving: false, message: null,
      },
      catalogoRows: [],
      catalogoSelecionado: null,
      catalogoHistory: [],
      catalogoPriceForm: { price: '', reason: '', marginPreset: null },
      catalogoMessage: null,
      apiPost: vi.fn().mockResolvedValue({ product_id: 'produto-metzeler' }),
      loadCatalogo: vi.fn(async function (this: { catalogoRows: unknown[] }) {
        this.catalogoRows = [{
          product_id: 'produto-metzeler',
          catalogued: true,
          brand: 'Metzeler',
          tire_size: '90/90-18',
          tire_condition: 'meia_vida',
          price_amount: null,
        }];
      }),
      catalogoLoadHistory: vi.fn().mockResolvedValue(undefined),
      $nextTick: vi.fn(),
    };

    module.catalogoCreateOpen.call(context, {
      catalogued: false, brand: 'Metzeler', tire_size: '90/90-18',
      tire_condition: 'meia_vida',
    });
    expect(context.catalogoCadastro).toMatchObject({
      open: true,
      form: {
        product_code: 'MET-909018-MV',
        product_name: 'Pneu Metzeler',
      },
    });

    await module.catalogoCreateSave.call(context);
    expect(context.apiPost).toHaveBeenCalledWith('/admin/api/catalog/products', {
      measure: '90/90-18',
      brand: 'Metzeler',
      tire_condition: 'meia_vida',
      product_code: 'MET-909018-MV',
      product_name: 'Pneu Metzeler',
    });
    expect(context.catalogoSelecionado).toMatchObject({
      product_id: 'produto-metzeler',
      price_amount: null,
    });
    expect(context.catalogoMessage).toMatchObject({
      ok: true,
      text: expect.stringContaining('defina o pre'),
    });
  });

  it('exibe o comando de cadastro e avisa que o preco ainda bloqueia a venda', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain("'Cadastrar produto'");
    expect(html).toContain('@click="catalogoCreateSave()"');
    expect(html).toContain('continuará bloqueado para venda');
    expect(html).toContain('data-testid="catalog-create-drawer"');
    expect(html).toContain('class="absolute inset-y-0 right-0 flex max-w-[440px] flex-col');
    expect(html).not.toContain('w-[min(520px,calc(100vw-24px))] -translate-x-1/2');
    expect(html).toContain('!catalogoCompatibilidade.open && !catalogoMarcaCorrecao.open');
    expect(html.match(/style="display:none;z-index:100" class="fixed inset-0"/g)).toHaveLength(4);
  });

  it('corrige Sem marca antes do cadastro e oferece continuar para o produto', async () => {
    const module = loadCatalogModule();
    const sourceRow = {
      row_key: 'stock:1008018::meia_vida',
      product_id: null,
      product_type: 'tire',
      catalogued: false,
      brand: 'Sem marca',
      tire_size: '100/80-18',
      tire_condition: 'meia_vida',
      official_quantity_on_hand: 10,
      official_unit_cost: 55.4,
    };
    const targetRow = {
      ...sourceRow,
      row_key: 'stock:1008018:rinaldi:meia_vida',
      brand: 'Rinaldi',
    };
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      catalogoSelecionado: null,
      catalogoCadastro: { open: false },
      catalogoCompatibilidade: { open: false },
      catalogoMarcaCorrecao: {
        open: false, row: null, from_brand: '', to_brand: '', reason: '',
        confirmed: false, idempotency_key: '', saving: false, message: null,
        result: null, result_row: null,
      },
      catalogoRows: [sourceRow],
      apiPost: vi.fn().mockResolvedValue({
        stock_id: 'stock-1', measure: '100/80-18', from_brand: 'Sem marca',
        to_brand: 'Rinaldi', tire_condition: 'meia_vida', quantity_on_hand: 10,
        unit_cost: 55.4, catalog_product_id: null, catalog_product_updated: false,
      }),
      loadCatalogo: vi.fn(async function (this: { catalogoRows: unknown[] }) {
        this.catalogoRows = [targetRow];
      }),
      $nextTick: vi.fn(),
    };

    await module.catalogoOpen.call(context, sourceRow);
    expect(context.catalogoMarcaCorrecao).toMatchObject({
      open: true,
      from_brand: 'Sem marca',
      row: sourceRow,
    });
    context.catalogoMarcaCorrecao.to_brand = 'Rinaldi';
    context.catalogoMarcaCorrecao.reason = 'Marca conferida fisicamente';
    context.catalogoMarcaCorrecao.confirmed = true;
    await module.catalogoBrandCorrectionSave.call(context);

    expect(context.apiPost).toHaveBeenCalledWith(
      '/admin/api/wholesale/stock/brand-correction',
      expect.objectContaining({
        measure: '100/80-18', from_brand: 'Sem marca', to_brand: 'Rinaldi',
        tire_condition: 'meia_vida', idempotency_key: 'brand-correction-key',
      }),
    );
    expect(context.catalogoMarcaCorrecao).toMatchObject({
      result_row: targetRow,
      message: { ok: true, text: expect.stringContaining('foram preservados') },
    });
    expect(module.__integrity.complete).toHaveBeenCalledWith(
      'stock-brand-correction', sourceRow.row_key,
    );

    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain('data-testid="catalog-brand-correction-drawer"');
    expect(html).toContain("catalogoIsUnknownBrand(row.brand) ? 'Corrigir marca'");
    expect(html).toContain('Confirmo que');
    expect(html).toContain('Cadastrar produto agora');
  });

  it('habilita compatibilidade apos o cadastro e abre as motos em painel lateral', async () => {
    const module = loadCatalogModule();
    const context = {
      ...module,
      catalogoSelecionado: { product_id: 'outro-produto' },
      catalogoCadastro: { open: false },
      catalogoCompatibilidade: {
        open: false, row: null, rows: [], summary: { models: 0, fitments: 0 },
        loading: false, error: null,
      },
      apiGet: vi.fn().mockResolvedValue({
        summary: { models: 1, fitments: 1 },
        rows: [{
          vehicle_model_id: 'neo-125', make: 'Yamaha', model: 'Neo 125', variant: 'UBS',
          year_start: 2017, year_end: 2026, position: 'front', is_oem: true,
          source: 'manual',
        }],
      }),
      $nextTick: vi.fn(),
    };

    await module.catalogoCompatibilityOpen.call(context, {
      product_id: 'produto-neo', product_name: 'Pneu Pirelli', tire_size: '80/80-14',
      catalogued: true,
    });

    expect(context.catalogoSelecionado).toBeNull();
    expect(context.catalogoCompatibilidade).toMatchObject({
      open: true,
      loading: false,
      summary: { models: 1, fitments: 1 },
    });
    expect(context.apiGet).toHaveBeenCalledWith('/admin/api/catalog/produto-neo/compatibility');
    expect(module.catalogoCompatibilityPositionLabel('front')).toBe('Dianteiro');
    expect(module.catalogoCompatibilityYearLabel({ year_start: 2017, year_end: 2026 }))
      .toBe('2017 a 2026');

    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain('<th class="px-4 py-3">Compatibilidade</th>');
    expect(html).toContain('data-testid="catalog-compatibility-drawer"');
    expect(html).toContain(":disabled=\"row.product_type !== 'tire' || row.catalogued === false || !row.product_id\"");
    expect(html).toContain('Nenhuma moto associada');
  });

  it('deixa funcionário somente consultar e não trata serviço como pneu sem marca', async () => {
    const module = loadCatalogModule();
    const employee = {
      ...module,
      adminUser: { role: 'employee' },
      catalogoSelecionado: null,
      catalogoCadastro: { open: false },
      catalogoMarcaCorrecao: { open: false },
      catalogoPriceForm: { price: '100.00', reason: 'Mudança' },
      catalogoSaving: false,
    };
    await module.catalogoOpen.call(employee, {
      product_id: 'servico-1', product_type: 'service', brand: null,
      catalogued: true, price_amount: 100,
    });
    expect(employee.catalogoSelecionado).toBeNull();
    expect(module.catalogoPodeSalvar.call(employee)).toBe(false);

    const owner = {
      ...employee,
      adminUser: { role: 'owner' },
      catalogoHistory: [],
      catalogoMessage: null,
      catalogoLoadHistory: vi.fn(),
      $nextTick: vi.fn(),
    };
    await module.catalogoOpen.call(owner, {
      product_id: 'servico-1', product_type: 'service', brand: null,
      catalogued: true, price_amount: 100,
    });
    expect(owner.catalogoSelecionado).toMatchObject({ product_id: 'servico-1' });
    expect(owner.catalogoMarcaCorrecao.open).toBe(false);

    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain('Catálogo em modo de consulta');
    expect(html).toContain('x-show="adminUser?.role === \'owner\'" type="button" @click="catalogoOpen(row)"');
    expect(html).toContain("row.product_type === 'service' ? 'Não se aplica'");
  });
});
