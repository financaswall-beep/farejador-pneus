(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const state = { stockId: '', stock: null, page: 1, rows: [], total: 0, hasMore: false, expanded: false, trigger: null };

  function text(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function quantity(value) {
    if (value == null) return 'Não informado';
    const amount = Number(value);
    return `${amount} ${amount === 1 ? 'unidade' : 'unidades'}`;
  }

  function status(value, service) {
    if (service) return 'Ativo';
    return {
      in_stock: 'Ativo', low_stock: 'Estoque baixo', out_of_stock: 'Sem estoque',
      reserved: 'Saldo reservado', untracked: 'Não controlado',
    }[value] || 'Ativo';
  }

  function condition(value) {
    return { novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' }[value] || '';
  }

  function itemIcon(type) {
    if (type === 'servico') {
      return Caixa.createSvg([{ d: 'm14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-6.6 6.6a2.1 2.1 0 0 0 3 3l6.6-6.6a5 5 0 0 1 6.4-6.4l-3 3-3-3Z' }]);
    }
    return Caixa.createSvg([
      { d: 'm4 7 8-4 8 4-8 4-8-4Z' }, { d: 'M4 7v10l8 4 8-4V7M12 11v10' },
    ]);
  }

  function movementIcon(kind) {
    const definitions = {
      purchase: [{ d: 'm12 4v16m-6-6 6 6 6-6' }],
      purchase_cancel: [{ d: 'm12 20V4m-6 6 6-6 6 6' }],
      sale: [{ d: 'M4 6h2l2 9h9l2-6H7m2 10h.01M17 19h.01' }],
      sale_cancel: [{ d: 'M4 6h2l2 9h9l2-6H7m7-6 3 3-3 3' }],
      count: [{ d: 'M8 4h8M9 2h6v4H9zM5 4h14v17H5zM8 12l2 2 5-5' }],
      registration: [{ d: 'm4 7 8-4 8 4-8 4-8-4ZM4 7v10l8 4 8-4V7M18 14v6m-3-3h6' }],
      update: [{ d: 'm4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z' }],
      price: [{ d: 'M12 3v18m4-14H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H7' }],
      reservation: [{ d: 'M6 4h12v16H6zM9 9h6m-6 4h6' }],
      reservation_release: [{ d: 'M6 4h12v16H6zM9 12h6' }],
    };
    return Caixa.createSvg(definitions[kind] || definitions.update);
  }

  function shortReference(value) {
    if (!value) return '';
    const clean = String(value);
    return clean.length > 12 ? clean.slice(0, 8).toUpperCase() : clean;
  }

  function movementTitle(row) {
    const reference = shortReference(row.reference_id);
    const suffix = reference ? ` #${reference}` : '';
    return {
      purchase: `Recebimento da compra${suffix}`,
      purchase_cancel: `Estorno da compra${suffix}`,
      sale: `Venda${suffix}`,
      sale_cancel: `Cancelamento da venda${suffix}`,
      count: row.quantity_delta === 0 ? 'Contagem conferida' : 'Ajuste de contagem aprovado',
      registration: 'Cadastro aprovado', update: 'Cadastro atualizado',
      price: 'Preço oficial atualizado',
      reservation: `Reserva da venda${suffix}`, reservation_release: `Reserva liberada${suffix}`,
    }[row.kind] || 'Movimentação de estoque';
  }

  function actor(value) {
    if (!value) return 'Sistema';
    if (value.startsWith('partner:')) return 'Proprietário';
    return value.replace(/^caixa:\s*/i, '').replace(/\s*\([^)]*\)\s*$/, '') || 'Sistema';
  }

  function occurredAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const same = function (left, right) { return left.toDateString() === right.toDateString(); };
    const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (same(date, now)) return `Hoje, ${time}`;
    if (same(date, yesterday)) return `Ontem, ${time}`;
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + `, ${time}`;
  }

  function movementQuantity(row) {
    if (row.quantity_delta == null) {
      if (row.kind === 'update') return 'Dados alterados';
      if (row.kind === 'price') return 'Preço registrado';
      return 'Cadastro';
    }
    const amount = Number(row.quantity_delta);
    if (amount === 0) return 'Sem diferença';
    const absolute = Math.abs(amount);
    return `${amount > 0 ? '+' : '−'}${absolute} ${absolute === 1 ? 'unidade' : 'unidades'}`;
  }

  function movementNode(row) {
    const item = document.createElement('li');
    item.className = `stock-movement stock-movement--${row.kind}`;
    const visual = document.createElement('span');
    visual.className = 'stock-movement-icon'; visual.appendChild(movementIcon(row.kind));
    const copy = document.createElement('div');
    copy.append(text('strong', movementTitle(row)), text('span', `${occurredAt(row.occurred_at)} · ${actor(row.actor_label)}`));
    const delta = text('b', movementQuantity(row));
    if (Number(row.quantity_delta) > 0) delta.classList.add('positive');
    if (Number(row.quantity_delta) < 0) delta.classList.add('negative');
    item.append(visual, copy, delta);
    return item;
  }

  function renderHistory() {
    const visible = state.expanded ? state.rows : state.rows.slice(0, 3);
    byId('stock-detail-history-list').replaceChildren(...visible.map(movementNode));
    byId('stock-detail-history-empty').classList.toggle('hidden', state.rows.length > 0);
    byId('stock-detail-history-total').textContent = state.total ? `${state.total} registros` : '';
    byId('stock-detail-history-expand').classList.toggle('hidden', state.rows.length <= 3);
    byId('stock-detail-history-expand').textContent = state.expanded ? 'Mostrar somente as últimas' : 'Ver histórico completo';
    byId('stock-detail-history-more').classList.toggle('hidden', !state.expanded || !state.hasMore);
  }

  function renderStock(row) {
    const service = row.item_type === 'servico';
    const tire = row.item_type === 'pneu';
    const identity = tire ? row.tire_size : row.item_name;
    const primary = [row.brand, identity].filter(Boolean).join(' ') || 'Item cadastrado';
    const name = tire && row.item_name !== row.tire_size ? row.item_name : '';
    byId('stock-detail-title').textContent = service ? 'Detalhes do serviço' : 'Detalhes do produto';
    byId('stock-detail-primary').textContent = primary;
    byId('stock-detail-name').textContent = name;
    byId('stock-detail-name').classList.toggle('hidden', !name);
    byId('stock-detail-code').textContent = row.local_sku ? `Código ${row.local_sku}` : 'Sem código interno';
    byId('stock-detail-position').textContent = [condition(row.tire_condition), row.tire_position].filter(Boolean).join(' · ') || (service ? 'Serviço' : 'Aplicação não informada');
    byId('stock-detail-status').textContent = status(row.stock_status, service);
    byId('stock-detail-stock-price').classList.toggle('hidden', service);
    byId('stock-detail-service-note').classList.toggle('hidden', !service);
    byId('stock-detail-available').textContent = quantity(row.quantity_available);
    byId('stock-detail-minimum').textContent = row.minimum_quantity == null ? 'Estoque mínimo não informado' : `Estoque mínimo: ${row.minimum_quantity}`;
    byId('stock-detail-price').textContent = row.sale_price == null ? 'Não definido' : Caixa.currency.format(Number(row.sale_price));
    byId('stock-detail-price-edit').classList.toggle('hidden', Caixa.stored(Caixa.keys.role) !== 'owner');
    byId('stock-detail-count').classList.toggle('hidden', service || !row.is_tracked);
    const edit = byId('stock-detail-edit');
    edit.disabled = Boolean(row.update_pending);
    edit.title = row.update_pending
      ? 'Alteração aguardando aprovação do proprietário'
      : 'Editar dados operacionais do cadastro';
    edit.querySelector('span').replaceChildren(
      document.createTextNode(row.update_pending ? 'Alteração em análise' : 'Editar cadastro'),
      text('small', row.update_pending ? 'Aguardando proprietário' : 'Vai para aprovação'),
    );
    byId('stock-detail-image').classList.toggle('hidden', !tire);
    byId('stock-detail-icon').classList.toggle('hidden', tire);
    if (!tire) byId('stock-detail-icon').replaceChildren(itemIcon(row.item_type));
    byId('stock-detail-visual').classList.toggle('stock-detail-visual--icon', !tire);
  }

  function setState(kind) {
    byId('stock-detail-loading').classList.toggle('hidden', kind !== 'loading');
    byId('stock-detail-error').classList.toggle('hidden', kind !== 'error');
    byId('stock-detail-content').classList.toggle('hidden', kind !== 'ready');
  }

  async function load(page) {
    if (!state.stockId) return;
    if (page === 1) setState('loading');
    byId('stock-detail-history-more').disabled = true;
    try {
      const path = `operacao/estoque/${encodeURIComponent(state.stockId)}?page=${page}&limit=20`;
      const response = await Caixa.authenticatedFetch(Caixa.operationPath(path));
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      if (page === 1) { state.rows = []; state.stock = payload.stock; renderStock(payload.stock); }
      state.rows = state.rows.concat(payload.history.rows || []);
      state.page = page; state.total = Number(payload.history.total || 0);
      state.hasMore = Boolean(payload.history.has_more);
      renderHistory(); setState('ready');
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      if (page === 1) setState('error'); else Caixa.showToast('Não foi possível carregar mais movimentações.');
    } finally {
      byId('stock-detail-history-more').disabled = false;
    }
  }

  function open(stockId, trigger) {
    state.stockId = stockId; state.page = 1; state.rows = []; state.total = 0;
    state.hasMore = false; state.expanded = false; state.trigger = trigger || null;
    byId('stock-detail-unit').textContent = Caixa.stored(Caixa.keys.store) || 'Unidade parceira';
    byId('stock-detail-operator-name').textContent = Caixa.stored(Caixa.keys.name) || 'Operador';
    Caixa.showTab('stock-detail');
    window.scrollTo({ top: 0, behavior: 'auto' });
    void load(1);
  }

  function back() {
    Caixa.showTab('stock');
    if (state.trigger && document.contains(state.trigger)) state.trigger.focus({ preventScroll: true });
  }

  byId('stock-detail-back').addEventListener('click', back);
  byId('stock-detail-retry').addEventListener('click', function () { void load(1); });
  byId('stock-detail-count').addEventListener('click', function () {
    const stockId = state.stockId; Caixa.showTab('stock'); if (stockId) Caixa.openStockCount(stockId);
  });
  byId('stock-detail-edit').addEventListener('click', function () {
    if (state.stock && Caixa.openStockEdit) Caixa.openStockEdit(state.stock);
  });
  byId('stock-detail-price-edit').addEventListener('click', function () {
    if (state.stock && Caixa.openStockPrice) Caixa.openStockPrice(state.stock);
  });
  byId('stock-detail-history-expand').addEventListener('click', function () { state.expanded = !state.expanded; renderHistory(); });
  byId('stock-detail-history-more').addEventListener('click', function () { void load(state.page + 1); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !byId('stock-detail-panel').classList.contains('hidden')) back();
  });

  Caixa.openStockDetail = open;
  Caixa.refreshStockDetail = function () { return load(1); };
}());
