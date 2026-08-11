(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const detailModal = byId('stock-detail-modal');
  let selectedStockId = '';
  let returnFocus = null;

  function text(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function icon(kind) {
    if (kind === 'servico') {
      return Caixa.createSvg([
        { d: 'M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-3-3L14.7 6.3Z' },
      ]);
    }
    return Caixa.createSvg([
      { d: 'm4 7 8-4 8 4-8 4-8-4Z' }, { d: 'M4 7v10l8 4 8-4V7M12 11v10' },
    ]);
  }

  function conditionLabel(value) {
    return { novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' }[value] || '';
  }

  function stockLabel(row) {
    if (!row.is_tracked || row.item_type === 'servico') return 'Sem controle de saldo';
    if (row.quantity_on_hand == null) return 'Saldo ainda não informado';
    const available = Number(row.quantity_available || 0);
    const reserved = Number(row.quantity_reserved || 0);
    return reserved > 0
      ? `${available} disponível · ${reserved} reservado`
      : `${available} ${available === 1 ? 'unidade' : 'unidades'}`;
  }

  function stockBadge(row) {
    const badge = text('span', stockLabel(row), 'stock-card-badge');
    if (['low_stock', 'out_of_stock', 'reserved'].includes(row.stock_status)) badge.classList.add('stock-card-badge--low');
    return badge;
  }

  function countButton(row) {
    if (!row.is_tracked || row.item_type === 'servico') return null;
    const count = document.createElement('button');
    count.type = 'button';
    count.className = 'stock-card-count';
    count.dataset.stockCount = row.stock_id;
    count.textContent = 'Contar';
    return count;
  }

  function tireContent(row) {
    const content = document.createElement('div');
    content.className = 'stock-card-content stock-card-content--tire';

    const identity = document.createElement('div');
    identity.className = 'stock-card-identity';
    identity.appendChild(text('strong', row.tire_size || row.item_name, 'stock-card-size'));
    if (row.tire_size && row.item_name !== row.tire_size) {
      identity.appendChild(text('span', row.item_name, 'stock-card-model'));
    }
    identity.appendChild(text('small', row.local_sku ? `Código ${row.local_sku}` : 'Sem código', 'stock-card-code'));
    const condition = text('span', conditionLabel(row.tire_condition) || 'Condição a confirmar', 'stock-card-condition');
    condition.classList.add(`stock-card-condition--${row.tire_condition || 'unknown'}`);
    identity.appendChild(condition);

    const actions = document.createElement('div');
    actions.className = 'stock-card-side';
    actions.appendChild(text('strong', row.brand || 'Sem marca', 'stock-card-brand'));
    actions.appendChild(stockBadge(row));
    const count = countButton(row);
    if (count) actions.appendChild(count);

    content.append(identity, actions);
    return content;
  }

  function genericContent(row) {
    const content = document.createElement('div');
    content.className = 'stock-card-content stock-card-content--generic';
    const kicker = [row.brand, row.local_sku ? `Cód. ${row.local_sku}` : ''].filter(Boolean).join(' · ');
    if (kicker) content.appendChild(text('small', kicker, 'stock-card-kicker'));
    content.appendChild(text('strong', row.item_name));
    const details = [row.tire_size, row.tire_position].filter(Boolean).join(' · ');
    if (details) content.appendChild(text('span', details, 'stock-card-details'));
    content.appendChild(stockBadge(row));
    const count = countButton(row);
    if (count) content.appendChild(count);
    return content;
  }

  function createStockCard(row) {
    const card = document.createElement('article');
    card.className = 'stock-card';
    card.dataset.stockDetail = row.stock_id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Ver detalhes de ${row.tire_size || row.item_name}`);

    const visual = document.createElement('div');
    visual.className = 'stock-card-visual' + (row.item_type === 'pneu' ? '' : ' stock-card-visual--icon');
    if (row.item_type === 'pneu') {
      const image = document.createElement('img');
      image.src = '/caixa/catalog-tire.webp';
      image.alt = '';
      visual.appendChild(image);
    } else visual.appendChild(icon(row.item_type));

    const content = row.item_type === 'pneu' ? tireContent(row) : genericContent(row);
    card.append(visual, content);
    return card;
  }

  function filteredRows(rows) {
    const state = Caixa.stockState;
    const query = state.query.toLocaleLowerCase('pt-BR');
    return rows.filter(function (row) {
      const correctType = state.type === 'servico' ? row.item_type === 'servico' : row.item_type !== 'servico';
      if (!correctType) return false;
      if (!query) return true;
      return [row.item_name, row.brand, row.tire_size, row.local_sku]
        .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(query);
    });
  }

  function renderList() {
    const state = Caixa.stockState;
    const list = byId('stock-list');
    const rows = filteredRows(state.rows);
    list.replaceChildren(...rows.map(createStockCard));
    byId('stock-loading').classList.add('hidden');
    byId('stock-error').classList.add('hidden');
    byId('stock-empty').classList.toggle('hidden', rows.length > 0);
    list.classList.toggle('hidden', rows.length === 0);
  }

  function renderSummary(payload) {
    const rows = payload.rows || [];
    const products = rows.filter(function (row) { return row.item_type !== 'servico'; });
    byId('stock-units').textContent = String(products.reduce(function (sum, row) {
      return sum + Number(row.quantity_on_hand || 0);
    }, 0));
    byId('stock-products').textContent = String(products.length);
    byId('stock-low').textContent = String(products.filter(function (row) {
      return ['low_stock', 'out_of_stock', 'reserved'].includes(row.stock_status);
    }).length);

    const pending = payload.pending || {};
    const total = Number(pending.item_registrations || 0) + Number(pending.stock_counts || 0);
    const banner = byId('stock-pending');
    banner.textContent = total === 1 ? '1 solicitação aguardando aprovação do dono' : `${total} solicitações aguardando aprovação do dono`;
    banner.classList.toggle('hidden', total === 0);
  }

  function statusLabel(value, service) {
    if (service) return 'Disponível para venda';
    return {
      in_stock: 'Em estoque', low_stock: 'Estoque baixo', out_of_stock: 'Sem estoque',
      reserved: 'Saldo reservado', untracked: 'Saldo não controlado',
    }[value] || 'Ativo';
  }

  function quantity(value) {
    return value == null ? 'Não informado' : `${Number(value)} un.`;
  }

  function detailIcon(type) {
    if (type === 'servico') {
      return Caixa.createSvg([{ d: 'm14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-6.6 6.6a2.1 2.1 0 0 0 3 3l6.6-6.6a5 5 0 0 1 6.4-6.4l-3 3-3-3Z' }]);
    }
    return Caixa.createSvg([
      { d: 'm4 7 8-4 8 4-8 4-8-4Z' }, { d: 'M4 7v10l8 4 8-4V7M12 11v10' },
    ]);
  }

  function fillDetail(row) {
    const service = row.item_type === 'servico';
    const tire = row.item_type === 'pneu';
    byId('stock-detail-kicker').textContent = service ? 'Serviço cadastrado' : 'Produto cadastrado';
    byId('stock-detail-title').textContent = service ? 'Detalhes do serviço' : 'Detalhes do produto';
    byId('stock-detail-brand').textContent = row.brand || (service ? 'Serviço da loja' : 'Sem marca');
    byId('stock-detail-primary').textContent = tire && row.tire_size ? row.tire_size : row.item_name;
    byId('stock-detail-name').textContent = tire && row.tire_size && row.item_name !== row.tire_size ? row.item_name : '';
    byId('stock-detail-name').classList.toggle('hidden', !byId('stock-detail-name').textContent);
    byId('stock-detail-code').textContent = row.local_sku ? `Código ${row.local_sku}` : 'Sem código interno';
    byId('stock-detail-condition').textContent = tire ? conditionLabel(row.tire_condition) : (service ? 'Serviço' : 'Material');
    byId('stock-detail-position').textContent = tire && row.tire_position ? row.tire_position : (tire ? 'Posição não informada' : 'Cadastro operacional');
    byId('stock-detail-on-hand').textContent = quantity(row.quantity_on_hand);
    byId('stock-detail-available').textContent = quantity(row.quantity_available);
    byId('stock-detail-reserved').textContent = quantity(row.quantity_reserved || 0);
    byId('stock-detail-minimum').textContent = quantity(row.minimum_quantity);
    byId('stock-detail-shelf').textContent = row.shelf_location || 'Não informada';
    byId('stock-detail-status').textContent = statusLabel(row.stock_status, service);
    byId('stock-detail-balance').classList.toggle('hidden', service);
    byId('stock-detail-service-note').classList.toggle('hidden', !service);
    byId('stock-detail-count').classList.toggle('hidden', service || !row.is_tracked);
    byId('stock-detail-image').classList.toggle('hidden', !tire);
    byId('stock-detail-icon').classList.toggle('hidden', tire);
    if (!tire) byId('stock-detail-icon').replaceChildren(detailIcon(row.item_type));
    byId('stock-detail-visual').classList.toggle('stock-detail-visual--icon', !tire);
  }

  function openDetail(stockId, trigger) {
    const row = Caixa.stockState.rows.find(function (item) { return item.stock_id === stockId; });
    if (!row) return;
    selectedStockId = stockId;
    returnFocus = trigger || null;
    fillDetail(row);
    detailModal.classList.remove('hidden');
    detailModal.querySelector('[data-close-stock-detail]')?.focus({ preventScroll: true });
  }

  function closeDetail() {
    detailModal.classList.add('hidden');
    selectedStockId = '';
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  byId('stock-list').addEventListener('click', function (event) {
    if (event.target.closest('[data-stock-count]')) return;
    const card = event.target.closest('[data-stock-detail]');
    if (card) openDetail(card.dataset.stockDetail || '', card);
  });
  byId('stock-list').addEventListener('keydown', function (event) {
    if (!['Enter', ' '].includes(event.key) || event.target.closest('[data-stock-count]')) return;
    const card = event.target.closest('[data-stock-detail]');
    if (!card) return;
    event.preventDefault();
    openDetail(card.dataset.stockDetail || '', card);
  });
  byId('stock-detail-count').addEventListener('click', function () {
    const stockId = selectedStockId;
    closeDetail();
    if (stockId) Caixa.openStockCount(stockId);
  });
  document.querySelectorAll('[data-close-stock-detail]').forEach(function (button) { button.addEventListener('click', closeDetail); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !detailModal.classList.contains('hidden')) closeDetail();
  });

  Caixa.stockView = {
    renderList: renderList,
    renderSummary: renderSummary,
    openDetail: openDetail,
  };
}());
