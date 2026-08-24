(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  let searchTimer = 0;
  let stockSelection = null;

  function state() { return Caixa.operationCatalogState; }
  function utils() { return Caixa.operationCatalogUtils; }
  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content != null) element.textContent = String(content);
    return element;
  }
  function visible(element, show) {
    if (element) element.classList.toggle('hidden', !show);
  }
  function brandVisual(brand, compact) {
    const wrapper = node('span', compact ? 'operation-catalog-brand compact' : 'operation-catalog-brand');
    const logoUrl = Caixa.catalogBrandLogo(brand);
    if (!logoUrl) {
      wrapper.appendChild(node('span', 'operation-catalog-brand-fallback', brand || 'Sem marca'));
      return wrapper;
    }
    const image = node('img', 'operation-catalog-brand-logo');
    image.src = logoUrl;
    image.alt = brand || '';
    image.addEventListener('error', function () {
      image.replaceWith(node('span', 'operation-catalog-brand-fallback', brand || 'Sem marca'));
    }, { once: true });
    wrapper.appendChild(image);
    return wrapper;
  }

  function renderSummary(summary) {
    const values = {
      'operation-catalog-kpi-products': summary.products,
      'operation-catalog-kpi-brands': summary.brands,
      'operation-catalog-kpi-available': summary.with_local_stock,
      'operation-catalog-kpi-no-price': summary.without_local_price,
    };
    Object.entries(values).forEach(function (entry) {
      const element = byId(entry[0]);
      if (element) element.textContent = String(utils().number(entry[1]));
    });
  }
  function renderBrandFilters() {
    const container = byId('operation-catalog-brand-filters');
    if (!container) return;
    container.replaceChildren(...['', ...state().brands].map(function (brand) {
      const button = node('button', 'operation-catalog-brand-filter');
      button.type = 'button';
      button.dataset.catalogBrand = brand;
      button.classList.toggle('active', state().brand === brand);
      button.setAttribute('aria-pressed', String(state().brand === brand));
      if (brand) button.appendChild(brandVisual(brand, true));
      else button.textContent = 'Todas';
      button.addEventListener('click', function () {
        if (state().brand === brand) return;
        state().brand = brand;
        void Caixa.loadOperationCatalog(1);
      });
      return button;
    }));
  }

  function closeStockSelection() {
    if (stockSelection) stockSelection.classList.add('hidden');
  }
  function ensureStockSelection() {
    if (stockSelection) return stockSelection;
    const modal = node('div', 'operation-catalog-stock-modal hidden');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const sheet = node('section', 'operation-catalog-stock-sheet');
    const heading = node('div', 'operation-catalog-stock-heading');
    const close = node('button', 'operation-catalog-stock-close', 'Fechar');
    close.type = 'button';
    close.addEventListener('click', closeStockSelection);
    heading.append(node('div', '', 'Escolha qual item terá o preço alterado'), close);
    sheet.append(heading, node('div', 'operation-catalog-stock-list'));
    modal.appendChild(sheet);
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closeStockSelection();
    });
    document.body.appendChild(modal);
    stockSelection = modal;
    return modal;
  }
  function openPrice(row) {
    const helper = utils();
    if (!helper.isOwner() || typeof Caixa.openStockPrice !== 'function') return;
    const entries = helper.localEntries(row);
    if (entries.length === 1) {
      Caixa.openStockPrice(helper.selectedStockRow(row, entries[0]));
      return;
    }
    if (entries.length < 2) return;
    const modal = ensureStockSelection();
    const list = modal.querySelector('.operation-catalog-stock-list');
    list.replaceChildren(...entries.map(function (entry, index) {
      const option = node('button', 'operation-catalog-stock-option');
      option.type = 'button';
      option.append(
        node('strong', '', entry.item_name || row.product_name || 'Item ' + (index + 1)),
        node('span', '', [entry.local_sku ? 'Cód. ' + entry.local_sku : '', entry.shelf_location || '']
          .filter(Boolean).join(' · ') || 'Linha ' + (index + 1)),
        node('span', '', helper.number(entry.quantity_available) + ' disponíveis · '
          + (helper.money(entry.sale_price) ? Caixa.currency.format(Number(entry.sale_price)) : 'sem preço')),
      );
      option.addEventListener('click', function () {
        closeStockSelection();
        Caixa.openStockPrice(helper.selectedStockRow(row, entry));
      });
      return option;
    }));
    modal.classList.remove('hidden');
    list.querySelector('button')?.focus({ preventScroll: true });
  }

  function statusFor(row) {
    const helper = utils();
    if (!row.has_local_stock) return 'Fora do estoque da unidade';
    if (!helper.priceRange(row)) return 'Preço pendente';
    if (helper.available(row) <= 0) return 'Sem saldo disponível';
    return 'Disponível para venda';
  }
  function createCard(row) {
    const helper = utils();
    const card = node('article', 'operation-catalog-card');
    const main = node('div', 'operation-catalog-card-main');
    const identity = node('div', 'operation-catalog-identity');
    main.appendChild(brandVisual(row.brand));
    identity.append(
      node('strong', '', row.tire_size || row.product_name || row.product_code || 'Produto'),
      node('span', '', row.product_name && row.product_name !== row.tire_size ? row.product_name : ''),
    );
    const meta = [helper.conditionLabel(row.tire_condition), helper.positionLabel(row.tire_position), row.product_code]
      .filter(Boolean).join(' · ');
    if (meta) identity.appendChild(node('small', 'operation-catalog-meta', meta));
    main.appendChild(identity);
    const stock = node('div', 'operation-catalog-stock');
    stock.append(node('small', '', 'Saldo da unidade'), node('strong', '', helper.available(row) + ' un.'));
    const price = node('div', 'operation-catalog-price');
    price.append(node('small', '', 'Preço da unidade'), node('strong', '', helper.priceLabel(row)));
    const actions = node('div', 'operation-catalog-actions');
    if (Caixa.isPartner() && row.product_type === 'tire' && row.product_id) {
      const fitment = node('button', 'operation-catalog-fitment-open',
        helper.number(row.compatibility_count) > 0 ? 'Ver motos compatíveis' : 'Consultar compatibilidade');
      fitment.type = 'button';
      fitment.addEventListener('click', function () { void Caixa.openOperationCatalogCompatibility(row); });
      actions.appendChild(fitment);
    }
    const entries = helper.localEntries(row);
    if (helper.isOwner() && entries.length > 0 && typeof Caixa.openStockPrice === 'function') {
      const edit = node('button', 'operation-catalog-price-open',
        entries.length > 1 ? 'Escolher item e alterar preço' : 'Alterar preço');
      edit.type = 'button';
      edit.addEventListener('click', function () { openPrice(row); });
      actions.appendChild(edit);
    }
    card.append(main, node('div', 'operation-catalog-status', statusFor(row)), stock, price, actions);
    return card;
  }

  function filteredMatrixRows() {
    const helper = utils();
    const query = state().query.toLocaleLowerCase('pt-BR');
    return state().rows.filter(function (row) {
      if (state().brand && String(row.brand || '').toLocaleLowerCase('pt-BR')
        !== state().brand.toLocaleLowerCase('pt-BR')) return false;
      if (state().filter === 'stock' && helper.available(row) <= 0) return false;
      if (state().filter === 'no_price' && helper.priceRange(row)) return false;
      return !query || [row.tire_size, row.product_name, row.product_code, row.brand]
        .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(query);
    });
  }
  function render() {
    const list = byId('operation-catalog-list');
    if (!list) return;
    const rows = Caixa.isPartner() ? state().rows : filteredMatrixRows();
    const cards = rows.map(createCard);
    if (Caixa.isPartner() && state().page < state().pages) {
      const more = node('button', 'operation-catalog-load-more', 'Carregar mais produtos');
      more.type = 'button';
      more.addEventListener('click', function () { void Caixa.loadOperationCatalog(state().page + 1, true); });
      cards.push(more);
    }
    list.replaceChildren(...cards);
    visible(byId('operation-catalog-loading'), false);
    visible(byId('operation-catalog-error'), false);
    visible(byId('operation-catalog-empty'), rows.length === 0);
    visible(list, rows.length > 0);
    renderBrandFilters();
  }
  function setLoading(append) {
    if (append) return;
    visible(byId('operation-catalog-loading'), true);
    visible(byId('operation-catalog-error'), false);
    visible(byId('operation-catalog-empty'), false);
    visible(byId('operation-catalog-list'), false);
  }
  function showError() {
    visible(byId('operation-catalog-loading'), false);
    visible(byId('operation-catalog-list'), false);
    visible(byId('operation-catalog-empty'), false);
    visible(byId('operation-catalog-error'), true);
  }

  function closeCompatibility() { visible(byId('operation-catalog-fitment-modal'), false); }
  function openCompatibility(row) {
    byId('operation-catalog-fitment-title').textContent = row.tire_size || row.product_name || 'Compatibilidade';
    byId('operation-catalog-fitment-subtitle').textContent = row.brand || '';
    byId('operation-catalog-fitment-list').replaceChildren();
    visible(byId('operation-catalog-fitment-list'), false);
    visible(byId('operation-catalog-fitment-loading'), true);
    visible(byId('operation-catalog-fitment-error'), false);
    visible(byId('operation-catalog-fitment-modal'), true);
  }
  function fitmentLabel(row) {
    const years = row.year_start || row.year_end
      ? (row.year_start && row.year_end && row.year_start !== row.year_end
        ? row.year_start + ' a ' + row.year_end : String(row.year_start || row.year_end))
      : 'Todos os anos cadastrados';
    return [years, utils().positionLabel(row.position) || 'Posição não informada', row.is_oem ? 'Original' : '']
      .filter(Boolean).join(' · ');
  }
  function renderCompatibility(rows) {
    const list = byId('operation-catalog-fitment-list');
    list.replaceChildren(...rows.map(function (row) {
      const item = node('article', 'operation-catalog-fitment');
      item.append(node('strong', '', [row.make, row.model, row.variant].filter(Boolean).join(' ') || 'Moto'),
        node('span', '', fitmentLabel(row)));
      return item;
    }));
    if (!rows.length) list.appendChild(node('p', 'operation-catalog-fitment-empty', 'Nenhuma moto homologada para este pneu.'));
    visible(list, true);
  }
  function showCompatibilityError() { visible(byId('operation-catalog-fitment-error'), true); }
  function finishCompatibility() { visible(byId('operation-catalog-fitment-loading'), false); }

  function bind() {
    const fitmentModal = byId('operation-catalog-fitment-modal');
    if (fitmentModal && fitmentModal.parentElement !== document.body) document.body.appendChild(fitmentModal);
    byId('operation-catalog-retry')?.addEventListener('click', function () { void Caixa.loadOperationCatalog(1); });
    byId('operation-catalog-search')?.addEventListener('input', function (event) {
      state().query = event.target.value.trim();
      visible(byId('operation-catalog-search-clear'), Boolean(state().query));
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(function () { void Caixa.loadOperationCatalog(1); }, 280);
    });
    byId('operation-catalog-search-clear')?.addEventListener('click', function () {
      const search = byId('operation-catalog-search');
      if (!search) return;
      search.value = '';
      state().query = '';
      visible(byId('operation-catalog-search-clear'), false);
      search.focus({ preventScroll: true });
      void Caixa.loadOperationCatalog(1);
    });
    document.querySelectorAll('[data-operation-catalog-filter]').forEach(function (button) {
      button.addEventListener('click', function () {
        state().filter = ['stock', 'no_price'].includes(button.dataset.operationCatalogFilter)
          ? button.dataset.operationCatalogFilter : 'all';
        document.querySelectorAll('[data-operation-catalog-filter]').forEach(function (item) {
          const active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-pressed', String(active));
        });
        void Caixa.loadOperationCatalog(1);
      });
    });
    document.querySelectorAll('[data-close-operation-catalog-fitment]').forEach(function (button) {
      button.addEventListener('click', closeCompatibility);
    });
    byId('operation-catalog-fitment-modal')?.addEventListener('click', function (event) {
      if (event.target === byId('operation-catalog-fitment-modal')) closeCompatibility();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      closeCompatibility();
      closeStockSelection();
    });
  }

  Caixa.operationCatalogView = Object.freeze({
    renderSummary: renderSummary, render: render, setLoading: setLoading, showError: showError,
    openCompatibility: openCompatibility, renderCompatibility: renderCompatibility,
    showCompatibilityError: showCompatibilityError, finishCompatibility: finishCompatibility,
  });
  bind();
}());
