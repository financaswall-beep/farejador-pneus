(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  const V = C.partnerBuyUI;
  const state = { rows: [], loaded: false, loading: false, error: '', cart: new Map(), query: '', vehicle: 'motorcycle', sending: false, sent: null, checkoutEnabled: false };
  let generation = 0;
  let account = '';
  let page = null;
  let mountedMode = '';
  let list = null;
  let notice = null;
  let key = '';
  let origin = 'partner-buy';
  const identity = row => row.offer_key || JSON.stringify([row.measure, row.brand || 'Sem marca', row.tire_condition]);
  const measureKey = value => String(value || '').replace(/[^\d]/g, '');
  function variantKey(row) {
    const brand = String(row.brand || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return JSON.stringify([measureKey(row.measure), brand === 'semmarca' ? '' : brand, row.tire_condition]);
  }
  const allowed = () => C.isPartner() && C.token() && C.canModule('estoque');
  function canSend() { return state.checkoutEnabled && (C.stored(C.keys.role) === 'owner' || C.canModule('compras')); }
  function checkAccount() {
    const next = C.sessionFingerprint();
    if (account && account !== next) reset();
    account = next;
  }
  function sanitize(row) {
    const available = Number(row.quantity_available);
    const cents = row.price_cents == null ? null : Number(row.price_cents);
    if (!row.measure || !['meia_vida', 'novo', 'remold'].includes(row.tire_condition)
      || !Number.isSafeInteger(available) || available < 0 || (cents != null && (!Number.isSafeInteger(cents) || cents <= 0))) return null;
    return { ...row, offer_key: identity(row), quantity_available: available, price_cents: cents };
  }
  function currentMode() {
    return ({ 'partner-buy': 'catalog', 'partner-cart': 'cart', 'partner-replenishment': 'replenishment' })[C.partnerHome.currentTab()];
  }
  async function load() {
    if (!allowed()) return;
    checkAccount(); if (state.loading) return;
    const version = generation; const session = account;
    state.loading = true; state.error = ''; render(currentMode());
    try {
      const response = await C.partnerData.api('operacao/comprar');
      if (version !== generation || session !== C.sessionFingerprint()) return;
      state.rows = (response.rows || []).map(sanitize).filter(row => row && row.price_cents != null); state.loaded = true;
      state.checkoutEnabled = response.checkout_enabled === true;
      state.cart.forEach(entry => {
        const row = state.rows.find(row => row.offer_key === entry.row.offer_key);
        entry.row = row || { ...entry.row, quantity_available: 0 };
      });
    } catch (_) {
      if (version !== generation || session !== C.sessionFingerprint()) return;
      state.error = 'Não consegui atualizar o galpão. Tente novamente.'; state.loaded = false;
    } finally {
      if (version === generation && session === C.sessionFingerprint()) {
        state.loading = false; render(currentMode());
      }
    }
  }
  function entries() { return [...state.cart.values()]; }
  function replenishmentRows() {
    const eligible = C.partnerData.state.offers.filter(row => row.quantity_available > 0);
    const seen = new Set();
    // A reposição identifica a variante; preço, saldo e chave do carrinho vêm do catálogo publicado.
    return C.partnerData.opportunities().flatMap(demand => state.rows.filter(row =>
      measureKey(row.measure) === measureKey(demand.measure) && eligible.some(offer =>
        variantKey(offer) === variantKey(row) && (!offer.vehicle_type || offer.vehicle_type === row.vehicle_type))
    ).filter(row => {
      if (seen.has(row.offer_key)) return false;
      seen.add(row.offer_key); return true;
    }).map(row => ({ ...row, demand_count: Number(demand.demand_count) })));
  }
  function count() { return entries().reduce((total, entry) => total + entry.quantity, 0); }
  function add(row) {
    if (!allowed() || !state.loaded || state.sending) return;
    checkAccount(); const live = state.rows.find(item => item.offer_key === row.offer_key);
    if (!live) return;
    const previous = state.cart.get(live.offer_key); const quantity = (previous?.quantity || 0) + 1;
    if (quantity > live.quantity_available) { C.showToast('Não há mais unidades disponíveis.'); return; }
    state.cart.set(live.offer_key, { row: live, quantity }); key = ''; state.sent = null;
    C.showToast('Pneu adicionado ao carrinho.'); render(currentMode());
  }
  function change(id, delta) {
    if (!allowed() || state.sending) return;
    checkAccount(); const entry = state.cart.get(id); if (!entry) return;
    const quantity = delta == null ? 0 : entry.quantity + delta;
    if (quantity > entry.row.quantity_available && delta > 0) return;
    if (quantity <= 0) state.cart.delete(id); else entry.quantity = quantity;
    key = ''; state.sent = null; render('cart');
  }
  function cart() { origin = C.partnerHome.currentTab() === 'partner-replenishment' ? 'partner-replenishment' : 'partner-buy'; C.partnerHome.open('partner-cart'); }
  function message(text, error) { return U.node('p', text, 'ps-buy-message' + (error ? ' ps-buy-error' : '')); }
  function setup(mode) {
    page = U.node('section', null, 'ps-screen ps-buy ps-buy--' + mode); mountedMode = mode;
    page.appendChild(V.heading(mode, count(), { back: () => C.partnerHome.open(mode === 'cart' ? origin : 'partner-home'), cart }));
    if (mode === 'catalog') {
      const search = U.node('label', null, 'ps-buy-search');
      search.appendChild(C.createSvg([{ d: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6' }]));
      const input = U.node('input'); input.type = 'search'; input.inputMode = 'numeric'; input.placeholder = 'Buscar medida';
      input.setAttribute('aria-label', 'Buscar medida no galpão'); input.value = state.query;
      input.addEventListener('input', () => { state.query = input.value; draw(mode); }); search.appendChild(input);
      const vehicles = U.node('div', null, 'ps-buy-vehicles');
      ['motorcycle', 'car'].forEach(value => {
        const choice = V.control(value === 'car' ? 'Carro' : 'Moto', () => {
          state.vehicle = value; page = null; render('catalog');
        }, value === state.vehicle ? 'selected' : 'metal', value);
        choice.setAttribute('aria-pressed', String(value === state.vehicle)); vehicles.appendChild(choice);
      });
      page.append(search, vehicles, V.intro('Pneus disponíveis no galpão', null, 'tire'));
    } else if (mode === 'replenishment') page.appendChild(V.intro('Te pediram e você não tinha', 'Nos últimos 7 dias'));
    notice = U.node('div'); notice.setAttribute('aria-live', 'polite');
    list = U.node('div', null, 'ps-buy-list'); page.append(notice, list);
    U.mount(page, 'buy-' + mode); U.root.scrollTop = 0;
  }
  function draw(mode) {
    notice.replaceChildren(); list.replaceChildren();
    const header = page.children[0]; header.replaceWith?.(V.heading(mode, count(), { back: () => C.partnerHome.open(mode === 'cart' ? origin : 'partner-home'), cart }));
    const refresh = mode === 'replenishment' ? C.partnerReplenishment.refresh : load;
    if (state.error) notice.append(message(state.error, true), V.control('TENTAR DE NOVO', refresh));
    if (mode === 'cart') { drawCart(); return; }
    if (state.error) return;
    let rows = state.rows;
    if (mode === 'replenishment') {
      if (C.partnerData.state.errors.includes('replenishment')) {
        notice.append(message('Não consegui atualizar a reposição. Tente novamente.', true), V.control('TENTAR DE NOVO', refresh)); return;
      }
      if (!state.loaded || !C.partnerData.state.ready) { notice.appendChild(message('Conferindo disponibilidade…')); return; }
      rows = replenishmentRows();
    } else {
      if (state.loading && !state.loaded) { notice.appendChild(message('Conferindo disponibilidade…')); return; }
      const query = state.query.replace(/[^\d]/g, '');
      rows = rows.filter(row => row.vehicle_type === state.vehicle && (!query || row.measure.replace(/[^\d]/g, '').includes(query)));
    }
    rows.filter(row => row.measure && row.quantity_available > 0).forEach(row => list.appendChild(V.product(row, {
      demand: mode === 'replenishment' ? row.demand_count : null,
      inCart: state.cart.get(row.offer_key)?.quantity || 0, busy: !state.loaded || state.loading || state.sending || (mode === 'replenishment' && C.partnerReplenishment.loading()),
      add: () => add(row),
    })));
    if (!list.children.length) notice.appendChild(message(mode === 'replenishment'
      ? C.partnerData.opportunities().length ? 'Essas medidas ainda não estão disponíveis para compra na 2W.' : 'Nenhuma oportunidade de reposição agora.'
      : 'Nenhum pneu disponível para essa busca.'));
  }
  function drawCart() {
    page.querySelectorAll('.ps-buy-summary,.ps-buy-cart-count-copy,.ps-buy-cart-note,.ps-buy-send,.ps-buy-continue').forEach(el => el.remove());
    if (state.sent) {
      notice.appendChild(V.intro('Pedido enviado', 'A 2W vai confirmar seu pedido.', 'check'));
      if (state.sent.request_number) notice.appendChild(message(state.sent.request_number));
      page.appendChild(V.control('Continuar comprando', () => C.partnerHome.open(origin), 'continue')); return;
    }
    if (!state.cart.size) {
      notice.appendChild(message('Seu carrinho está vazio.'));
      page.appendChild(V.control('Continuar comprando', () => C.partnerHome.open(origin), 'continue')); return;
    }
    const measures = new Set(entries().map(entry => entry.row.measure)).size;
    const text = count() + (count() === 1 ? ' pneu' : ' pneus') + ' • ' + measures + (measures === 1 ? ' medida' : ' medidas');
    page.children[0].after?.(U.node('p', text, 'ps-buy-cart-count-copy'));
    entries().forEach(entry => list.appendChild(V.product(entry.row, {
      quantity: entry.quantity, busy: state.sending,
      minus: () => change(entry.row.offer_key, -1), plus: () => change(entry.row.offer_key, 1), remove: () => change(entry.row.offer_key, null),
    })));
    const invalid = entries().some(entry => entry.quantity > entry.row.quantity_available);
    if (invalid) notice.appendChild(message('O estoque mudou. Ajuste as quantidades para enviar.', true));
    const quoted = entries().some(entry => entry.row.price_cents == null);
    const total = entries().reduce((sum, entry) => sum + (entry.row.price_cents || 0) * entry.quantity, 0);
    const summary = U.node('div', null, 'ps-buy-summary');
    summary.append(U.node('span', 'Total do pedido'), U.node('strong', quoted ? 'A cotar' : V.money(total), 'ps-buy-total'));
    const send = V.control(state.sending ? 'ENVIANDO…' : 'ENVIAR PEDIDO', submit, 'primary', 'cart'); send.classList.add('ps-buy-send');
    send.disabled = state.sending || !state.loaded || invalid || !canSend();
    page.append(summary, U.node('p', !state.checkoutEnabled ? 'Envio de pedidos em breve.' : canSend() ? 'Confira os itens antes de enviar.' : 'Seu acesso não permite enviar compras.', 'ps-buy-cart-note'), send,
      V.control('Continuar comprando', () => C.partnerHome.open(origin), 'continue'));
  }
  async function submit() {
    if (!allowed() || !canSend() || state.sending || !state.loaded || !state.cart.size) return;
    checkAccount(); if (!state.cart.size || entries().some(entry => entry.quantity > entry.row.quantity_available)) return;
    const version = generation; const session = account;
    key ||= window.crypto?.randomUUID?.() || 'compra-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const payload = { idempotency_key: key, items: entries().map(entry => ({ offer_key: entry.row.offer_key, quantity: entry.quantity, expected_price_cents: entry.row.price_cents })) };
    state.sending = true; state.error = ''; render('cart');
    try {
      const result = await C.partnerData.api('operacao/comprar/pedidos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (version !== generation || session !== C.sessionFingerprint()) return;
      state.sent = result; state.cart.clear(); key = ''; C.showToast('Pedido enviado para a 2W.');
    } catch (error) {
      if (version !== generation || session !== C.sessionFingerprint()) return;
      state.error = ({ stock_changed: 'O estoque mudou. Atualize e confira as quantidades.', price_changed: 'O preço mudou. Atualize e confira o novo total.', idempotency_conflict: 'Esse envio já mudou. Atualize antes de tentar novamente.' })[error?.message] || 'Não consegui enviar. Seu carrinho foi mantido. Tente novamente.';
    } finally {
      if (version === generation && session === C.sessionFingerprint()) { state.sending = false; render(currentMode()); }
    }
  }
  function render(mode) {
    if (!allowed() || !mode) return;
    checkAccount(); if (!page || mountedMode !== mode || U.root.dataset.view !== 'buy-' + mode) setup(mode);
    draw(mode);
  }
  function reset() {
    ++generation; account = ''; page = list = notice = null; key = ''; mountedMode = ''; origin = 'partner-buy';
    Object.assign(state, { rows: [], loaded: false, loading: false, error: '', query: '', vehicle: 'motorcycle', sending: false, sent: null, checkoutEnabled: false }); state.cart.clear();
  }
  C.partnerBuy = { load, render, reset, state, count, busy: () => state.sending };
}());
