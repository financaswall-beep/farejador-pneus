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

  function stockBadge(row) {
    const badge = text('span', stockLabel(row), 'stock-card-badge');
    if (['low_stock', 'out_of_stock', 'reserved'].includes(row.stock_status)) badge.classList.add('stock-card-badge--low');
    return badge;
  }

  function matrixPrice(row) {
    if (Caixa.isPartner()) return null;
    const box = document.createElement('div');
    box.className = 'stock-card-price';
    box.appendChild(text('small', 'Preço oficial'));
    box.appendChild(text('b', row.sale_price == null ? 'Não definido' : Caixa.currency.format(Number(row.sale_price))));
    if (Caixa.stored(Caixa.keys.role) === 'owner' && row.product_id) {
      const edit = document.createElement('button');
      edit.type = 'button'; edit.textContent = 'Alterar'; edit.dataset.stockPrice = row.stock_id;
      edit.addEventListener('click', function (event) {
        event.stopPropagation();
        if (Caixa.openStockPrice) Caixa.openStockPrice(row);
      });
      box.appendChild(edit);
    }
    return box;
  }

  function countButton(row) {
    if (!Caixa.isPartner() || !row.is_tracked || row.item_type === 'servico') return null;
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
    const price = matrixPrice(row);
    if (price) actions.appendChild(price);
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
    if (Caixa.isPartner()) {
      card.dataset.stockDetail = row.stock_id;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Ver detalhes de ${row.tire_size || row.item_name}`);
    } else {
      card.classList.add('stock-card--readonly');
    }

    const visual = document.createElement('div');
    visual.className = 'stock-card-visual' + (row.item_type === 'pneu' ? '' : ' stock-card-visual--icon');
    if (row.item_type === 'pneu') {
      const image = document.createElement('img');
      image.src = '/operacao/catalog-tire.webp';
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

  byId('stock-list').addEventListener('click', function (event) {
    if (event.target.closest('[data-stock-count],[data-stock-price]')) return;
    const card = event.target.closest('[data-stock-detail]');
    if (card) Caixa.openStockDetail(card.dataset.stockDetail || '', card);
  });
  byId('stock-list').addEventListener('keydown', function (event) {
    if (!['Enter', ' '].includes(event.key) || event.target.closest('[data-stock-count]')) return;
    const card = event.target.closest('[data-stock-detail]');
    if (!card) return;
    event.preventDefault();
    Caixa.openStockDetail(card.dataset.stockDetail || '', card);
  });

  Caixa.stockView = {
    renderList: renderList,
    renderSummary: renderSummary,
  };
}());
