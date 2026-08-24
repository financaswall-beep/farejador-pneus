(function () {
  'use strict';

  const Caixa = window.Caixa;
  const state = Caixa.operationCatalogState = {
    rows: [], brands: [], summary: {}, page: 1, pages: 1,
    query: '', brand: '', filter: 'all', request: 0,
  };

  function number(value) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function money(value) {
    return value == null || !(Number(value) > 0) ? null : Number(value);
  }
  function isOwner() {
    return typeof Caixa.isOwner === 'function'
      ? Caixa.isOwner() : Caixa.stored(Caixa.keys.role) === 'owner';
  }
  function available(row) { return number(row.local_quantity_available); }
  function priceRange(row) {
    const min = money(row.local_sale_price_min);
    const max = money(row.local_sale_price_max);
    return min == null ? null : { min: min, max: max == null ? min : max };
  }
  function priceLabel(row) {
    const range = priceRange(row);
    if (!range) return 'Preço não definido';
    return range.max > range.min
      ? Caixa.currency.format(range.min) + ' a ' + Caixa.currency.format(range.max)
      : Caixa.currency.format(range.min);
  }
  function conditionLabel(value) {
    return { novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' }[value] || '';
  }
  function positionLabel(value) {
    return { front: 'Dianteiro', rear: 'Traseiro', both: 'Dianteiro e traseiro' }[value] || '';
  }
  function localEntries(row) {
    if (row._matrixStock) return [row._matrixStock];
    if (!Array.isArray(row.local_stock_entries)) return [];
    return row.local_stock_entries.filter(function (entry) {
      return entry && typeof entry.stock_id === 'string';
    });
  }
  function selectedStockRow(row, entry) {
    return {
      ...entry,
      stock_id: entry.stock_id,
      item_name: entry.item_name || row.product_name || row.tire_size || 'Produto',
      tire_size: row.tire_size || entry.tire_size || null,
      brand: row.brand || entry.brand || null,
      sale_price: money(entry.sale_price),
      product_id: row.product_id || entry.product_id || null,
    };
  }

  function normalizeMatrixRow(row) {
    const price = money(row.sale_price);
    return {
      product_id: row.product_id || null,
      product_code: row.local_sku || '',
      product_name: row.item_name || row.tire_size || 'Produto',
      product_type: row.item_type === 'servico' ? 'service' : 'tire',
      tire_condition: row.tire_condition || null,
      tire_position: row.tire_position || null,
      tire_size: row.tire_size || null,
      brand: row.brand || null,
      has_local_stock: true,
      local_quantity_on_hand: number(row.quantity_on_hand),
      local_quantity_reserved: number(row.quantity_reserved),
      local_quantity_available: number(row.quantity_available),
      local_sale_price_min: price,
      local_sale_price_max: price,
      compatibility_count: 0,
      _matrixStock: row,
    };
  }

  function orderedBrands(rows, supplied) {
    const present = new Map();
    [...(supplied || []), ...rows.map(function (row) { return row.brand; })]
      .filter(Boolean).forEach(function (brand) {
        present.set(String(brand).toLocaleLowerCase('pt-BR'), String(brand));
      });
    const ordered = [];
    Caixa.catalogLogoBrands.forEach(function (brand) {
      const key = brand.toLocaleLowerCase('pt-BR');
      ordered.push(present.get(key) || brand);
      present.delete(key);
    });
    return ordered.concat([...present.values()].sort(function (a, b) {
      return a.localeCompare(b, 'pt-BR');
    }));
  }
  function matrixSummary(rows) {
    return {
      products: rows.length,
      brands: new Set(rows.map(function (row) { return row.brand; }).filter(Boolean)).size,
      with_local_stock: rows.filter(function (row) { return available(row) > 0; }).length,
      without_local_price: rows.filter(function (row) { return !priceRange(row); }).length,
    };
  }
  function view() { return Caixa.operationCatalogView; }

  async function loadOperationCatalog(page, append) {
    if (!Caixa.canModule || !Caixa.canModule('estoque')) return;
    const requestedPage = Math.max(1, Number(page) || 1);
    const request = ++state.request;
    view()?.setLoading(Boolean(append));
    try {
      let payload;
      if (Caixa.isPartner()) {
        const params = new URLSearchParams({
          page: String(requestedPage), limit: '40', type: 'all', filter: state.filter,
        });
        if (state.query) params.set('q', state.query);
        if (state.brand) params.set('brand', state.brand);
        const response = await Caixa.authenticatedFetch(
          Caixa.operationPath('painel/catalogo?' + params.toString()),
        );
        payload = await Caixa.json(response);
        if (!response.ok) throw new Error(payload.error || 'request_failed');
      } else {
        const response = await Caixa.authenticatedFetch(Caixa.operationPath('operacao/estoque'));
        const stock = await Caixa.json(response);
        if (!response.ok) throw new Error(stock.error || 'request_failed');
        const rows = (stock.rows || []).map(normalizeMatrixRow);
        payload = { rows: rows, brands: [], page: 1, pages: 1, summary: matrixSummary(rows) };
      }
      if (request !== state.request) return;
      const incoming = Array.isArray(payload.rows) ? payload.rows : [];
      state.rows = append ? state.rows.concat(incoming) : incoming;
      state.page = number(payload.page) || requestedPage;
      state.pages = Math.max(1, number(payload.pages) || 1);
      state.summary = payload.summary || matrixSummary(state.rows);
      state.brands = orderedBrands(state.rows, payload.brands);
      view()?.renderSummary(state.summary);
      view()?.render();
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      if (request === state.request) view()?.showError();
    }
  }

  async function openCompatibility(row) {
    if (!Caixa.isPartner() || !row.product_id || !view()) return;
    view().openCompatibility(row);
    try {
      const path = 'painel/catalogo/' + encodeURIComponent(row.product_id) + '/compatibilidade';
      const response = await Caixa.authenticatedFetch(Caixa.operationPath(path));
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      view().renderCompatibility(Array.isArray(payload.rows) ? payload.rows : []);
    } catch (failure) {
      if (!(failure instanceof Error && failure.message === 'invalid_session')) {
        view().showCompatibilityError();
      }
    } finally {
      view()?.finishCompatibility();
    }
  }

  Caixa.operationCatalogUtils = Object.freeze({
    number: number, money: money, isOwner: isOwner, available: available,
    priceRange: priceRange, priceLabel: priceLabel,
    conditionLabel: conditionLabel, positionLabel: positionLabel,
    localEntries: localEntries, selectedStockRow: selectedStockRow,
  });
  Object.assign(Caixa, {
    loadOperationCatalog: loadOperationCatalog,
    openOperationCatalogCompatibility: openCompatibility,
  });
}());
