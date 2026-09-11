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
  vm.runInNewContext(readFileSync('painel/public/app.catalogo.bootstrap.js', 'utf8'), sandbox);
  vm.runInNewContext(
    readFileSync('painel/public/app.catalogo.compatibilidade.js', 'utf8'),
    sandbox,
  );
  vm.runInNewContext(readFileSync('painel/public/app.catalogo.marca.js', 'utf8'), sandbox);
  return {
    ...sandbox.window.PAINEL_MODULES.catalogo(),
    ...sandbox.window.PAINEL_MODULES.catalogoBootstrap(),
    ...sandbox.window.PAINEL_MODULES.catalogoCompatibilidade(),
    ...sandbox.window.PAINEL_MODULES.catalogoMarca(),
    __integrity: integrity,
  };
}

describe('catalogo no painel', () => {
  it('completa uma medida sem inventar marca e condição nem abrir correção de estoque', async () => {
    const module = loadCatalogModule();
    const context = { ...module, adminUser: { role: 'owner' }, $nextTick: vi.fn(),
      catalogoBrandCorrectionOpen: vi.fn(), catalogoCadastro: {} };
    await context.catalogoOpen({ measure_draft: true, tire_size: '160/60-17', product_type: 'tire' });
    expect(context.catalogoCadastro).toMatchObject({ mode: 'manual', open: true,
      form: { measure: '160/60-17', brand: '', tire_condition: '', position: '' } });
    expect(context.catalogoBrandCorrectionOpen).not.toHaveBeenCalled();
    expect(context.catalogoCreateCanSave()).toBe(false);
    context.catalogoMarca = 'Pirelli';
    context.catalogoSetFiltro('incompleto');
    expect(context.catalogoMarca).toBe('todas');
    Object.assign(context.catalogoCadastro.form, { brand: 'Pirelli', tire_condition: 'novo' });
    context.catalogoCreateSuggestCode();
    expect(context.catalogoCreateCanSave()).toBe(true);
  });

  it('consulta motos e anos antes de haver um produto ou marca', async () => {
    const module = loadCatalogModule();
    const context = { ...module, $nextTick: vi.fn(), catalogoCadastro: { open: false },
      apiGet: vi.fn().mockResolvedValue({ applications: [{ model: 'NMAX', position: 'rear',
        year_start: 2017, year_end: 2022 }], application_reviews: [] }),
      catalogoDiscoveryLoad: vi.fn(), catalogoCompatibilidade: {} };
    await context.catalogoCompatibilityOpen({ tire_size: '130/70-13', measure_draft: true, product_type: 'tire' });
    expect(context.apiGet).toHaveBeenCalledWith('/admin/api/catalog/measure-applications?measure=130%2F70-13');
    expect(context.catalogoDiscoveryLoad).not.toHaveBeenCalled();
    expect(context.catalogoCompatibilidade.applications[0].position).toBe('rear');
    expect(context.catalogoCompatibilityYearLabel(context.catalogoCompatibilidade.applications[0])).toBe('2017 a 2022');
  });
  it('mostra só a medida no título do pneu, sem repetir nome e medida', () => {
    const module = loadCatalogModule();
    const row = Object.freeze({ product_type: 'tire', product_name: 'Pneu Vipal 110/90-17',
      brand: 'Vipal', tire_size: '110/90-17' });
    expect(module.catalogoTitle(row)).toBe('110/90-17');
    expect(module.catalogoTitle({ ...row, tire_size: ' 140/70R17 ' })).toBe('140/70-17');
    expect(module.catalogoTitle({ ...row, product_name: '110/90-17 · 110/90-17' })).toBe('110/90-17');
    expect(row.product_name).toBe('Pneu Vipal 110/90-17');
    expect(row.brand).toBe('Vipal');
    expect(module.catalogoTitle({ product_type: 'service', product_name: 'Montagem', tire_size: '110/90-17' })).toBe('Montagem');
    expect(module.catalogoTitle({ product_name: 'Produto sem medida', tire_size: ' ' })).toBe('Produto sem medida');
    expect(module.catalogoTitle(null)).toBe('');
  });

  it('exibe aplicações do fabricante separadas da aprovação de produtos', async () => {
    const module = loadCatalogModule();
    const app = { application_id: 'reference-1', make: 'Honda', model: 'CB 300F', position: 'rear' };
    const context = { ...module, catalogoCompatibilidade: { row: { product_id: 'p1' }, applications: [] },
      apiGet: vi.fn().mockResolvedValue({ rows: [], applications: [app], summary: { models: 0, fitments: 0 } }),
      $nextTick: vi.fn() };
    await module.catalogoCompatibilityLoad.call(context, 'p1');
    expect(context.catalogoCompatibilidade.applications).toEqual([app]);
    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain('Aplicações consultadas no fabricante');
    expect(html).toContain('catalogoCompatibilidade.applications');
    expect(html).toContain('partnerCatalogo.applications');
    expect(html).toContain('Não é homologação automática do produto em estoque');
    expect(html).toContain('Em uso pelo Bot — não precisa aprovar uma por uma.');
    expect(html).toContain('catalogoCompatibilidade.discoveries.filter(item => !item.active_reference)');
    expect(html).toContain('Ver registro original');
  });

  it('não exige clique nem envia promoção para referência já em uso', async () => {
    const module = loadCatalogModule();
    const context = { ...module, adminUser: { role: 'owner' },
      catalogoCompatibilidade: { row: { product_id: 'p1' }, saving: false, message: null },
      apiPost: vi.fn() };
    await module.catalogoDiscoveryReview.call(context, { discovery_id: 'd1', active_reference: {} }, 'approve');
    expect(context.apiPost).not.toHaveBeenCalled();
    expect(context.catalogoCompatibilidade.message).toMatchObject({ ok: true });
  });
  it('simplifica R e ZR só na apresentação, preservando a especificação original', () => {
    const module = loadCatalogModule();
    const row = Object.freeze({ product_type: 'tire', tire_size: '140/70R17',
      product_name: 'Pneu Rinaldi 140/70R17', tire_construction: 'radial' });
    expect(module.catalogoMeasureLabel(row.tire_size)).toBe('140/70-17');
    expect(module.catalogoProductLabel(row)).toBe('Pneu Rinaldi 140/70-17');
    expect(module.catalogoTechnicalLabel(row)).toBe('Especificação original: 140/70R17 · Construção: radial');
    expect(module.catalogoMeasureLabel(' 120 / 70 ZR 17 ')).toBe('120/70-17');
    expect(module.catalogoMeasureLabel('2.75R17')).toBe('2.75-17');
    expect(row.tire_size).toBe('140/70R17');
    expect(row.product_name).toBe('Pneu Rinaldi 140/70R17');
    expect(row.tire_construction).toBe('radial');
  });

  it('não apaga B, marcas, nomes de serviços nem inventa construção para medida simples', () => {
    const module = loadCatalogModule();
    expect(module.catalogoMeasureLabel('150/80B16')).toBe('150/80B16');
    expect(module.catalogoMeasureLabel('90/90-18')).toBe('90/90-18');
    expect(module.catalogoMeasureLabel(null)).toBe('—');
    expect(module.catalogoProductLabel({ product_name: 'Pneu Rinaldi R15 Sport' }))
      .toBe('Pneu Rinaldi R15 Sport');
    expect(module.catalogoProductLabel({ product_type: 'service', product_name: 'Serviço 140/70R17' }))
      .toBe('Serviço 140/70R17');
    expect(module.catalogoTechnicalLabel({ tire_size: '140/70-17' })).toContain('não informada');
    expect(module.catalogoTechnicalLabel({ tire_size: '140/70-17', tire_construction: 'radial' }))
      .toContain('Construção: radial');
    expect(module.catalogoTechnicalLabel({ tire_size: '140/70R17', tire_construction: 'bias' }))
      .toContain('Construção divergente');
  });

  it('pesquisa pela medida exibida sem substituir o valor usado nas operações', () => {
    const module = loadCatalogModule();
    const row = Object.freeze({ product_id: 'radial-1', tire_size: '140/70R17',
      product_name: 'Pneu 140/70R17', tire_construction: 'radial', tire_condition: 'novo' });
    const context = { ...module, catalogoRows: [row], catalogoBusca: '140/70-17',
      catalogoMarca: 'todas', catalogoFiltro: 'todos' };
    expect(context.catalogoFiltrados()).toEqual([row]);
    context.catalogoBusca = '140/70R17';
    expect(context.catalogoFiltrados()).toEqual([row]);
    expect(row.tire_size).toBe('140/70R17');
  });

  it('usa apresentação comum na Matriz e parceiro e mantém detalhe técnico visível', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain('x-text="catalogoTitle(row)"');
    expect(html).toContain('x-text="catalogoTechnicalLabel(catalogoCompatibilidade.row)"');
    expect(html).toContain('x-text="catalogoTechnicalLabel(catalogoSelecionado)"');
    expect(html).toContain('x-text="catalogoTechnicalLabel(partnerCatalogo.selected)"');
    expect(html).not.toContain("[row.product_name,row.tire_size].filter(Boolean).join(' · ')");
  });

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
    expect(html).toContain('/admin/painel/tailwind.css?v=20260828-partner-pickups2');
    expect(html.includes('app.catalogo.js?v=20260911-measure-registration1')).toBe(true);
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
      'Rinaldi', 'Maggion', 'Technic', 'Vipal', 'Mitas', 'Kenda', 'CEAT', 'IRA', 'IRC',
    ];

    for (const brand of brands) {
      expect(module.catalogoBrandLogo(brand)).toMatch(
        /^\/admin\/painel\/assets\/catalog-brands\/[a-z]+\.webp\?v=20260824-catalog-brand3$/,
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
        product_name: 'Pneu Metzeler 90/90-18',
      },
    });

    await module.catalogoCreateSave.call(context);
    expect(context.apiPost).toHaveBeenCalledWith('/admin/api/catalog/products', {
      measure: '90/90-18',
      brand: 'Metzeler',
      tire_condition: 'meia_vida',
      product_code: 'MET-909018-MV',
      product_name: 'Pneu Metzeler 90/90-18',
      tread_pattern: null,
      load_index: null,
      speed_rating: null,
      position: null,
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

  it('cadastra a medida antes da compra sem criar saldo e volta com a variante preenchida', async () => {
    const module = loadCatalogModule();
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      catalogoCadastro: { open: false },
      catalogoRows: [],
      catalogoSelecionado: null,
      compraForm: { items: [{ measure: '', brand: '', tire_condition: '', quantity: 1, unit_cost: '' }] },
      compraMsg: null,
      currentPage: 'catalogo',
      apiPost: vi.fn().mockResolvedValue({
        product_id: 'produto-1', tire_size: '90/90-18', brand: 'Levorin',
        tire_condition: 'meia_vida', price_amount: 45,
      }),
      loadCatalogo: vi.fn(async function (this: { catalogoRows: unknown[] }) {
        this.catalogoRows = [{ product_id: 'produto-1', catalogued: true }];
      }),
      comprasOpenTab: vi.fn(),
      compraAddItem: vi.fn(),
      $nextTick: vi.fn(),
    };

    module.catalogoCreateNew.call(context);
    Object.assign(context.catalogoCadastro.form, {
      measure: '90/90-18', brand: 'Levorin', tire_condition: 'meia_vida',
      product_code: 'LEV-909018-MV', product_name: 'Pneu Levorin 90/90-18', price_amount: '45,00',
    });
    await module.catalogoCreateSave.call(context, true);

    expect(context.apiPost).toHaveBeenCalledWith('/admin/api/catalog/products', {
      measure: '90/90-18', brand: 'Levorin', tire_condition: 'meia_vida',
      product_code: 'LEV-909018-MV', product_name: 'Pneu Levorin 90/90-18',
      creation_mode: 'manual', price_amount: 45,
      price_reason: 'Preço inicial do cadastro',
      tread_pattern: null, load_index: null, speed_rating: null, position: null,
    });
    expect(context.compraForm.items[0]).toMatchObject({
      measure: '90/90-18', brand: 'Levorin', tire_condition: 'meia_vida',
      quantity: 1, unit_cost: '',
    });
    expect(context.currentPage).toBe('compras');
    expect(context.comprasOpenTab).toHaveBeenCalledWith('nova');
  });

  it('filtra fichas pendentes e salva a posição do produto inteiro', async () => {
    const module = loadCatalogModule();
    const pending = { product_id: 'produto-1', product_type: 'tire', catalogued: true,
      brand: 'Michelin',
      tire_position: null, tread_pattern: null, load_index: null, speed_rating: null,
      price_amount: 89 };
    const refreshed = { ...pending, tire_position: 'rear', tread_pattern: 'City Extra',
      load_index: '63', speed_rating: 'P' };
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      catalogoRows: [pending], catalogoBusca: '', catalogoMarca: 'todas',
      catalogoFiltro: 'sem_posicao', catalogoPagina: 1, catalogoPorPagina: 7,
      catalogoSelecionado: null, catalogoHistory: [], catalogoMessage: null,
      catalogoSpecSaving: false, catalogoSpecMessage: null,
      apiGet: vi.fn().mockResolvedValue({ rows: [] }),
      apiPost: vi.fn().mockResolvedValue({ changed: true }),
      loadCatalogo: vi.fn(async function (this: { catalogoRows: unknown[] }) {
        this.catalogoRows = [refreshed];
      }),
      $nextTick: vi.fn(),
    };
    expect(module.catalogoFiltrados.call(context)).toEqual([pending]);
    await module.catalogoOpen.call(context, pending);
    Object.assign(context.catalogoSpecForm, {
      tread_pattern: ' City   Extra ', load_index: '63', speed_rating: 'p',
      position: 'rear', reason: 'Conferido na lateral do pneu',
    });
    await module.catalogoSaveSpec.call(context);
    expect(context.apiPost).toHaveBeenCalledWith('/admin/api/catalog/produto-1/spec', {
      tread_pattern: 'City   Extra', load_index: '63', speed_rating: 'p',
      position: 'rear', reason: 'Conferido na lateral do pneu',
    });
    expect(context.catalogoSelecionado).toEqual(refreshed);
    expect(context.catalogoSpecMessage).toMatchObject({ ok: true });
    context.catalogoFiltro = 'sem_posicao';
    expect(module.catalogoFiltrados.call(context)).toEqual([]);

    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain("catalogoSetFiltro('sem_posicao')");
    expect(html).toContain('x-model="catalogoSpecForm.position"');
    expect(html).toContain('@click="catalogoSaveSpec()"');
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
    expect(html.match(/style="display:none;z-index:100" class="fixed inset-0"/g)).toHaveLength(5);
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
    expect(html).toContain(":disabled=\"row.product_type !== 'tire' || !row.tire_size\"");
    expect(html).toContain('Nenhuma moto associada');
  });

  it('salva compatibilidade oficial e mantém pesquisa da internet pendente', async () => {
    const module = loadCatalogModule();
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      catalogoCompatibilidade: {
        row: { product_id: 'produto-1' }, saving: false, message: null,
        selectedVehicle: { vehicle_model_id: 'moto-1' }, search: 'Honda CG', searchRows: [],
        form: { position: 'rear', is_oem: true, source: 'manufacturer',
          year_start: '2016', year_end: '2026', reason: 'Manual oficial' },
        discoveryForm: {
          source_url: 'https://fabricante.example/manual', source_title: 'Manual',
          evidence_summary: 'Medida traseira confirmada', confidence_level: 0.9,
        },
        discoveries: [],
      },
      apiPost: vi.fn().mockResolvedValue({ status: 'pending' }),
      catalogoCompatibilityLoad: vi.fn(),
      catalogoDiscoveryLoad: vi.fn(),
      loadCatalogo: vi.fn(),
      $nextTick: vi.fn(),
    };

    await module.catalogoDiscoveryCreate.call(context);
    expect(context.apiPost).toHaveBeenCalledWith(
      '/admin/api/catalog/produto-1/fitment-discoveries',
      expect.objectContaining({
        vehicle_model_id: 'moto-1', source_url: 'https://fabricante.example/manual',
        suggested_is_oem: true, confidence_level: 0.9,
        year_start: 2016, year_end: 2026,
      }),
    );
    expect(context.catalogoCompatibilidade.message).toMatchObject({
      ok: true, text: expect.stringContaining('ainda não usa'),
    });

    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain('Pesquisa na internet para revisar');
    expect(html).toContain('o Bot não usa antes de você aprovar');
    expect(html).toContain('@click="catalogoDiscoveryReview(item,\'approve\')"');
    expect(html).toContain('x-model="catalogoCompatibilidade.form.year_start"');
    expect(html).toContain('x-model="catalogoCompatibilidade.form.year_end"');
  });

  it('salva a vigência da aplicação e bloqueia uma faixa invertida', async () => {
    const module = loadCatalogModule();
    const context = {
      ...module,
      adminUser: { role: 'owner' },
      catalogoCompatibilidade: {
        row: { product_id: 'produto-1' }, saving: false, message: null,
        selectedVehicle: { vehicle_model_id: 'nmax' }, search: 'NMAX', searchRows: [],
        form: { position: 'both', is_oem: true, source: 'manufacturer',
          year_start: '2026', year_end: '2016', reason: 'Manual Yamaha' },
      },
      apiPost: vi.fn().mockResolvedValue({ changed: true }),
      catalogoCompatibilityLoad: vi.fn(),
      loadCatalogo: vi.fn(),
    };

    expect(module.catalogoCompatibilityCanSave.call(context)).toBe(false);
    context.catalogoCompatibilidade.form.year_start = '2016';
    context.catalogoCompatibilidade.form.year_end = '2026';
    expect(module.catalogoCompatibilityCanSave.call(context)).toBe(true);
    await module.catalogoCompatibilitySave.call(context);

    expect(context.apiPost).toHaveBeenCalledWith('/admin/api/catalog/produto-1/compatibility', {
      vehicle_model_id: 'nmax', position: 'both', is_oem: true, source: 'manufacturer',
      confidence_level: 1, year_start: 2016, year_end: 2026, reason: 'Manual Yamaha',
    });
  });

  it('inicializa a fila de pesquisa antes de o Alpine avaliar o drawer oculto', () => {
    const stateSource = readFileSync('painel/public/app.js', 'utf8');
    expect(stateSource).toContain('discoveries: [], discoveriesLoading: false');
    expect(stateSource).toContain(
      "discoveryForm: { source_url: '', source_title: '', evidence_summary: '', confidence_level: 0.8 }",
    );
    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain('app.js?v=20260910-relatorios1');
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
