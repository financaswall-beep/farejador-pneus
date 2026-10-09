(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  const state = { rows: [], prices: new Map(), priceError: false, loaded: false, loading: false, saving: false, query: '', error: '', undo: null, lastLoad: 0 };
  let generation = 0;
  let page = null;
  let list = null;
  let notice = null;
  let add = null;
  function allowed() { return C.isPartner() && C.token() && C.canModule('estoque'); }
  function current(session, version) { return allowed() && session === C.sessionFingerprint() && version === generation; }
  function message(error) {
    if (error?.message === 'stock_balance_below_reserved') return 'Esses pneus estão separados. Atualize a lista.';
    if (error?.status === 403) return 'Seu acesso não permite alterar o estoque.';
    if (error?.message === 'stock_not_found') return 'Esse pneu mudou. Atualize a lista.';
    return 'Não consegui salvar. Atualize a lista antes de tentar de novo.';
  }
  function screw(card) {
    ['tl', 'tr', 'bl', 'br'].forEach(corner => {
      const pin = U.node('i', null, 'ps-stock-screw ps-stock-screw--' + corner);
      pin.setAttribute('aria-hidden', 'true'); card.appendChild(pin);
    });
  }
  function controls(row) {
    const area = U.node('div', null, 'ps-stock-controls');
    [-1, 1].forEach(delta => {
      const control = U.button(delta < 0 ? '−' : '+', () => adjust(row.stock_id, delta));
      control.classList.add('ps-stock-step');
      control.setAttribute('aria-label', (delta < 0 ? 'Diminuir' : 'Aumentar') + ' estoque de ' + row.tire_size + ' ' + U.condition(row.tire_condition) + (row.brand ? ' ' + row.brand : ''));
      control.disabled = state.saving || state.loading || !state.loaded || row.quantity_on_hand == null || !row.is_tracked
        || (delta < 0 && Number(row.quantity_on_hand) <= Number(row.quantity_reserved || 0))
        || (delta > 0 && Number(row.quantity_on_hand) >= 999999);
      area.appendChild(control);
    });
    return area;
  }
  function price(row) {
    const area = U.node('div', null, 'ps-stock-price-row');
    const copy = U.node('div', null, 'ps-stock-price-copy');
    const amount = state.prices.get(row.stock_id);
    copy.append(U.node('span', 'Preço de venda'), U.node('strong', state.priceError ? 'Preço indisponível'
      : amount == null ? 'Não definido' : C.currency.format(amount)));
    area.appendChild(copy);
    if (C.stored(C.keys.role) === 'owner') {
      const edit = U.button('Editar preço', () => {
        if (!allowed() || state.loading || state.saving || state.priceError || !state.loaded) return;
        C.openStockPrice({ ...row, sale_price: amount ?? null });
      }, 'secondary');
      edit.classList.add('ps-stock-price-edit');
      edit.disabled = state.loading || state.saving || state.priceError || !state.loaded || !C.openStockPrice;
      const pencil = C.createSvg([{ d: 'm15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 5Z' }]);
      pencil.setAttribute('aria-hidden', 'true'); edit.prepend(pencil); area.appendChild(edit);
    }
    return area;
  }
  function card(row) {
    const el = U.node('article', null, 'ps-stock-card'); screw(el);
    const heading = U.node('div', null, 'ps-stock-card-head');
    const copy = U.node('div', null, 'ps-stock-copy');
    copy.append(U.node('h4', row.tire_size || row.item_name), U.node('p', [U.condition(row.tire_condition), row.brand].filter(Boolean).join(' · ')));
    const total = U.node('div', null, 'ps-stock-total');
    total.append(U.node('span', 'NA LOJA'), U.node('strong', row.quantity_on_hand == null ? '—' : row.quantity_on_hand));
    heading.append(copy, total);
    const bottom = U.node('div', null, 'ps-stock-card-bottom');
    const availability = U.node('div', null, 'ps-stock-availability');
    const reserved = Number(row.quantity_reserved || 0);
    const available = row.quantity_on_hand == null ? null : Math.max(0, Number(row.quantity_on_hand) - reserved);
    availability.appendChild(U.node('b', available == null ? 'Saldo não informado' : available + (available === 1 ? ' disponível' : ' disponíveis')));
    if (reserved) {
      const lock = U.node('p', null, 'ps-stock-reserved');
      const icon = C.createSvg([{ d: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v12H5ZM12 15v3' }]);
      icon.setAttribute('aria-hidden', 'true'); lock.append(icon, U.node('span', reserved + (reserved === 1 ? ' separado' : ' separados')));
      availability.appendChild(lock);
    }
    bottom.append(availability, controls(row)); el.append(heading, price(row), bottom); return el;
  }
  function draw() {
    if (!list) return;
    const query = state.query.replace(/\D/g, '');
    const rows = state.rows.filter(row => row.item_type === 'pneu' && (!query || String(row.tire_size || '').replace(/\D/g, '').includes(query)));
    list.replaceChildren(); notice.replaceChildren();
    add.disabled = state.saving || state.loading;
    if (state.error) {
      const error = U.node('p', state.error, 'ps-error'); error.setAttribute('role', 'alert'); notice.appendChild(error);
      notice.appendChild(U.button('ATUALIZAR LISTA', () => load()));
    }
    if (state.priceError && state.loaded && !state.error) {
      notice.appendChild(U.node('p', 'Não consegui consultar os preços.', 'ps-error'));
      notice.appendChild(U.button('ATUALIZAR PREÇOS', () => load()));
    }
    if (state.undo && !state.error) {
      notice.appendChild(U.node('span', 'Saldo atualizado.'));
      const undo = U.button('Desfazer', () => adjust(state.undo, 1)); undo.classList.add('ps-stock-undo');
      undo.disabled = state.saving || state.loading; notice.appendChild(undo);
    }
    if (!state.loaded && !state.error) list.appendChild(U.node('p', 'Carregando…', 'ps-copy'));
    else if (!rows.length && state.loaded) list.appendChild(U.node('p', query ? 'Nenhum pneu nessa medida.' : 'Nenhum pneu cadastrado.', 'ps-copy'));
    else rows.forEach(row => list.appendChild(card(row)));
    list.setAttribute('aria-busy', String(state.saving || state.loading));
  }
  async function load() {
    if (!allowed() || state.loading || state.saving) return;
    const session = C.sessionFingerprint(); const version = generation;
    state.loading = true; state.error = ''; draw();
    try {
      const [stock, prices] = await Promise.allSettled([
        C.partnerData.api('operacao/estoque'), C.partnerData.api('operacao/estoque-valores'),
      ]);
      if (!current(session, version)) return;
      if (stock.status === 'rejected') throw stock.reason;
      state.rows = stock.value.rows || [];
      state.priceError = prices.status === 'rejected';
      state.prices = new Map(prices.status === 'fulfilled'
        ? (prices.value.rows || []).map(row => [row.stock_id, row.sale_price]) : []);
      state.loaded = true; state.lastLoad = Date.now();
    } catch (error) {
      if (!current(session, version)) return;
      state.loaded = false; state.error = 'Não consegui atualizar o estoque.';
    } finally {
      if (current(session, version)) { state.loading = false; draw(); }
    }
  }
  async function adjust(id, delta) {
    if (!allowed() || state.saving || state.loading || !state.loaded) return;
    const session = C.sessionFingerprint(); const version = generation;
    state.saving = true; state.error = ''; state.undo = null; draw();
    try {
      // Parte do saldo real mais recente; não usa a quantidade de uma tela antiga.
      const before = await C.partnerData.api('operacao/estoque');
      if (!current(session, version)) return;
      state.rows = before.rows || [];
      const row = state.rows.find(item => item.stock_id === id && item.item_type === 'pneu');
      if (!row || !row.is_tracked || row.quantity_on_hand == null) throw new Error('stock_not_found');
      const quantity = Number(row.quantity_on_hand) + delta;
      if (quantity < Number(row.quantity_reserved || 0)) throw new Error('stock_balance_below_reserved');
      if (quantity < 0 || quantity > 999999) throw new Error('invalid_quantity');
      await C.partnerData.api('operacao/estoque/' + encodeURIComponent(id) + '/saldo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity_on_hand: quantity }),
      });
      if (!current(session, version)) return;
      state.loaded = false;
      const after = await C.partnerData.api('operacao/estoque');
      if (!current(session, version)) return;
      state.rows = after.rows || []; state.loaded = true; state.lastLoad = Date.now();
      if (delta < 0) state.undo = id;
      C.showToast('Estoque atualizado.');
    } catch (error) {
      if (!current(session, version)) return;
      state.loaded = false; state.error = message(error);
    } finally {
      if (current(session, version)) { state.saving = false; draw(); }
    }
  }
  function render() {
    if (!allowed()) return;
    if (C.partnerStockForm.isOpen()) { C.partnerStockForm.render(); return; }
    if (!page) {
      page = U.section('Meus pneus'); page.classList.add('ps-stock');
      const search = U.node('label', null, 'ps-stock-search');
      const icon = C.createSvg([{ d: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6' }]); icon.setAttribute('aria-hidden', 'true');
      const input = U.node('input'); input.type = 'search'; input.inputMode = 'numeric'; input.placeholder = 'Buscar medida · Ex.: 9018'; input.value = state.query;
      input.setAttribute('aria-label', 'Buscar medida');
      input.addEventListener('input', () => { state.query = input.value; draw(); }); search.append(icon, input);
      add = U.button('ADICIONAR PNEU', () => C.partnerStockForm.open()); add.classList.add('ps-stock-add');
      const plus = C.createSvg([{ d: 'M12 4v16M4 12h16' }]); plus.setAttribute('aria-hidden', 'true'); add.prepend(plus);
      notice = U.node('div', null, 'ps-stock-notice'); notice.setAttribute('aria-live', 'polite');
      list = U.node('div', null, 'ps-stock-list'); page.append(search, add, notice, list); draw();
    }
    if (U.root.dataset.view !== 'stock') { U.mount(page, 'stock'); U.root.scrollTop = 0; }
    if (state.loaded && !state.error && Date.now() - state.lastLoad > 10000) void load();
  }
  function reset() {
    ++generation; page = list = notice = add = null;
    Object.assign(state, { rows: [], prices: new Map(), priceError: false, loaded: false, loading: false, saving: false, query: '', error: '', undo: null, lastLoad: 0 });
    C.partnerStockForm?.reset();
    C.resetStockPrice?.();
  }
  C.partnerStock = { load, render, reset, busy: () => state.saving || C.partnerStockForm.busy() || Boolean(C.stockPriceBusy?.()) };
}());
