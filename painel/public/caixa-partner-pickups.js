(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  let selected = '', error = '';
  let cancel = false, busy = false, generation = 0;
  const photos = new Map();
  const tires = row => (row.items || []).filter(item => !item.pickup_service_code);
  const quantity = value => Number(value || 0) + (Number(value) === 1 ? ' pneu' : ' pneus');
  const size = item => item.tire_size || item.label || item.item_name || 'Pneu';
  function plate(className) {
    return U.plate(className);
  }
  function avatar(row) {
    return U.avatar(row);
  }
  function identity(row, compact) {
    const el = U.node('div', null, 'pu-identity');
    const copy = U.node('div', null, 'pu-person');
    copy.append(U.node('strong', row.customer_name || 'Cliente'), U.node('p', U.orderLabel(row)));
    el.append(avatar(row), copy);
    if (compact) el.appendChild(U.node('span', quantity(tires(row).reduce((sum, item) => sum + Number(item.quantity || 0), 0)), 'pu-quantity-badge'));
    return el;
  }
  function section(title, back, type) {
    const page = U.section(title, back);
    page.classList.add('pu-screen', 'pu-screen--' + type); return page;
  }
  function mount(page, mode) {
    const scroll = U.root.scrollTop;
    const same = U.root.dataset.view === mode && U.root.dataset.pickup === selected;
    U.mount(page, mode); U.root.dataset.pickup = selected;
    U.root.scrollTop = same ? scroll : 0;
  }
  function list() {
    const page = section('Retiradas', () => C.partnerHome.open('partner-home'), 'list');
    const rows = C.partnerData.pendingPickups();
    const summary = U.node('div', null, 'pu-summary');
    summary.append(U.node('strong', rows.length === 1 ? '1 pedido aguardando retirada' : rows.length + ' pedidos aguardando retirada'),
      U.node('p', rows.length ? 'Toque no pedido de quem chegou.' : 'Nenhuma retirada pendente.'));
    page.appendChild(summary);
    if (C.partnerData.state.errors.includes('pickups')) {
      page.appendChild(U.node('p', 'Não consegui atualizar as retiradas.', 'ps-error'));
      page.appendChild(U.button('TENTAR DE NOVO', () => void C.partnerData.load(), 'secondary'));
    }
    rows.forEach(row => {
      const card = plate('pu-order'); card.appendChild(identity(row, true));
      const items = U.node('div', null, 'pu-order-items');
      tires(row).forEach(item => items.appendChild(U.node('p', size(item) + ' • ' + quantity(item.quantity))));
      card.appendChild(items);
      const button = U.button('VER RETIRADA', () => {
        leave(); selected = row.order_id; cancel = false; error = ''; C.partnerHome.open('partner-pickup');
      });
      button.appendChild(C.createSvg([{ d: 'M4 12h16m-6-6 6 6-6 6' }]));
      card.appendChild(button); page.appendChild(card);
    });
    mount(page, 'pickups');
  }
  function photoFrame(row, item) {
    const frame = U.node('div', null, 'pu-tire-photo');
    frame.append(U.icon('camera'), U.node('span', 'Sem foto do pneu'));
    if (!item.photo_request_id || !item.order_item_id) return frame;
    const key = row.order_id + '/' + item.order_item_id + '/' + item.photo_request_id;
    let entry = photos.get(key);
    if (!entry) {
      entry = { url: '', failed: false, controller: new AbortController() }; photos.set(key, entry);
      const session = C.sessionFingerprint(), current = generation;
      const path = 'operacao/retiradas/' + encodeURIComponent(row.order_id) + '/itens/' + encodeURIComponent(item.order_item_id) + '/foto';
      void (async () => {
        try {
          const response = await C.authenticatedFetch(C.operationPath(path), { signal: entry.controller.signal });
          if (!response.ok) throw new Error('photo_unavailable');
          const blob = await response.blob();
          if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw new Error('photo_unavailable');
          if (current !== generation || session !== C.sessionFingerprint()) return;
          entry.url = URL.createObjectURL(blob);
        } catch { entry.failed = true; }
        if (current === generation && session === C.sessionFingerprint() && C.partnerHome.currentTab() === 'partner-pickup') render();
      })();
    }
    if (entry.url) {
      const image = U.node('img'); image.alt = 'Foto do pneu ' + size(item); image.src = entry.url;
      image.addEventListener('error', () => { URL.revokeObjectURL(entry.url); entry.url = ''; entry.failed = true; render(); });
      frame.replaceChildren(image);
    } else if (!entry.failed) frame.replaceChildren(U.node('span', 'Carregando foto…'));
    return frame;
  }
  function serviceLabel(row) {
    const labels = { mounting: 'Montagem do pneu', valve_change: 'Troca de bico', balancing: 'Balanceamento' };
    const codes = [...new Set([...(row.pickup_services || []).map(service => service.code),
      ...(row.items || []).map(item => item.pickup_service_code).filter(Boolean)])];
    return codes.length ? codes.map(code => labels[code] || 'Serviço combinado').join(' • ') : 'Só retirada';
  }
  async function save(row, cancelling) {
    if (busy) return;
    busy = true; error = ''; render();
    const session = C.sessionFingerprint();
    try {
      const path = cancelling ? 'retiradas/' + encodeURIComponent(row.order_id)
        : 'operacao/retiradas/' + encodeURIComponent(row.order_id) + '/confirmar';
      const result = await C.partnerData.api(path, {
        method: cancelling ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cancelling ? { reason: 'Cliente não veio — cancelamento confirmado na Operação simples' } : {}),
      });
      if (session !== C.sessionFingerprint()) return;
      if (cancelling ? !result.cancelled : !result.retrieved) throw new Error('pickup_not_found');
      C.showToast(cancelling ? 'Reserva liberada.' : 'Retirada confirmada.');
      C.partnerData.state.pickups = C.partnerData.state.pickups.filter(item => item.order_id !== row.order_id);
      selected = ''; cancel = false; leave();
      await C.partnerData.load();
      if (session === C.sessionFingerprint()) C.partnerHome.open(C.partnerData.pendingPickups().length ? 'partner-pickups' : 'partner-home', true);
    } catch (failure) {
      if (session !== C.sessionFingerprint()) return;
      error = U.errorMessage(failure);
    } finally { if (session === C.sessionFingerprint()) { busy = false; C.partnerHome.render(); } }
  }
  function render() {
    const row = C.partnerData.pendingPickups().find(item => item.order_id === selected);
    if (!row) return list();
    const page = section(cancel ? 'Cliente não veio?' : 'Retirada', () => {
      if (busy) return;
      if (cancel) { cancel = false; render(); } else C.partnerHome.open('partner-pickups');
    }, 'detail');
    page.appendChild(U.node('h4', 'Quem veio buscar', 'pu-label'));
    const customer = plate('pu-customer'); customer.appendChild(identity(row, false)); page.appendChild(customer);
    if (cancel) {
      page.appendChild(U.node('p', 'Cancelar este pedido e liberar os pneus?', 'ps-copy'));
      page.appendChild(U.button(busy ? 'CANCELANDO…' : 'SIM, CANCELAR', () => void save(row, true), 'danger', 'close'));
      page.appendChild(U.button('MANTER PEDIDO', () => { cancel = false; render(); }, 'secondary'));
    } else {
      const items = tires(row);
      page.appendChild(U.node('h4', items.length > 1 ? 'Quais pneus entregar' : 'Qual pneu entregar', 'pu-label'));
      items.forEach(item => {
        const card = plate('pu-tire'); const content = U.node('div', null, 'pu-tire-main');
        const copy = U.node('div', null, 'pu-tire-copy');
        copy.append(U.node('strong', size(item), 'pu-size'), U.node('b', quantity(item.quantity), 'pu-tire-quantity'),
          U.node('p', [item.brand, U.condition(item.tire_condition)].filter(Boolean).join(' • '), 'pu-tire-brand'));
        content.append(photoFrame(row, item), copy); card.appendChild(content);
        const service = U.node('div', null, 'pu-service'); service.append(U.icon('pickup-solid'), U.node('span', serviceLabel(row)));
        card.appendChild(service); page.appendChild(card);
      });
      page.appendChild(U.node('p', items.length > 1 ? 'Confira os pneus antes de entregar.' : 'Confira o pneu antes de entregar.', 'pu-helper'));
      page.appendChild(U.button(busy ? 'CONFIRMANDO…' : 'CONFIRMAR RETIRADA', () => void save(row, false), 'primary', 'check'));
      const absent = U.button('Cliente não veio', () => { cancel = true; error = ''; render(); }, 'secondary');
      absent.prepend(C.createSvg([{ d: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6h5' }])); page.appendChild(absent);
    }
    if (error) { const el = U.node('p', error, 'ps-error'); el.setAttribute('role', 'alert'); page.appendChild(el); }
    page.querySelectorAll('button').forEach(el => { el.disabled = busy; });
    mount(page, 'pickup');
  }
  function leave() {
    ++generation; photos.forEach(entry => { entry.controller.abort(); if (entry.url) URL.revokeObjectURL(entry.url); }); photos.clear();
  }
  function reset() { leave(); selected = ''; cancel = false; busy = false; error = ''; }
  C.partnerPickups = { list, render, reset, leave, busy: () => busy };
}());
