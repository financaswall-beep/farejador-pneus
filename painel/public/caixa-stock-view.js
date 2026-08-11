(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };

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

  function createStockCard(row) {
    const card = document.createElement('article');
    card.className = 'stock-card';

    const visual = document.createElement('div');
    visual.className = 'stock-card-visual' + (row.item_type === 'pneu' ? '' : ' stock-card-visual--icon');
    if (row.item_type === 'pneu') {
      const image = document.createElement('img');
      image.src = '/caixa/catalog-tire.webp';
      image.alt = '';
      visual.appendChild(image);
    } else visual.appendChild(icon(row.item_type));

    const content = document.createElement('div');
    content.className = 'stock-card-content';
    const kicker = [row.brand, row.local_sku ? `Cód. ${row.local_sku}` : ''].filter(Boolean).join(' · ');
    if (kicker) content.appendChild(text('small', kicker, 'stock-card-kicker'));
    content.appendChild(text('strong', row.item_name));
    const details = [row.tire_size, conditionLabel(row.tire_condition), row.tire_position].filter(Boolean).join(' · ');
    if (details) content.appendChild(text('span', details, 'stock-card-details'));

    const badge = text('span', stockLabel(row), 'stock-card-badge');
    if (['low_stock', 'out_of_stock', 'reserved'].includes(row.stock_status)) badge.classList.add('stock-card-badge--low');
    content.appendChild(badge);

    if (row.is_tracked && row.item_type !== 'servico') {
      const count = document.createElement('button');
      count.type = 'button';
      count.className = 'stock-card-count';
      count.dataset.stockCount = row.stock_id;
      count.textContent = 'Contar';
      content.appendChild(count);
    }
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

  Caixa.stockView = {
    renderList: renderList,
    renderSummary: renderSummary,
  };
}());
