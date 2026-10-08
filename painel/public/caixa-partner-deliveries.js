(function () {
  'use strict';
  const C = window.Caixa, U = C.partnerUI;
  let selected = '', payment = '', error = '', problemReason = '';
  let paying = false, reporting = false, busy = false, generation = 0;
  const photos = new Map();
  const items = row => (row.items || []).filter(item => !item.pickup_service_code);
  const size = item => item.tire_size || item.label || item.item_name || 'Pneu';
  const quantity = item => Number(item.quantity || 0) + (Number(item.quantity) === 1 ? ' pneu' : ' pneus');
  const status = row => ({ pending: 'A preparar', dispatched: 'Em rota', failed: 'Com problema' })[row.delivery_status] || '';
  function mine(row) {
    const name = String(C.stored(C.keys.name) || '').trim().toLocaleLowerCase('pt-BR');
    return Boolean(name) && String(row.delivery_courier || '').trim().toLocaleLowerCase('pt-BR') === name;
  }
  function badge(row) { return U.node('span', status(row), 'pd-badge pd-badge--' + row.delivery_status); }
  function identity(row, compact) {
    const el = U.node('div', null, 'pu-identity'), copy = U.node('div', null, 'pu-person');
    copy.append(U.node('strong', row.customer_name || 'Cliente'), U.node('p', U.orderLabel(row)));
    el.append(U.avatar(row), copy); if (compact) el.appendChild(badge(row)); return el;
  }
  function section(title, back, mode) {
    const page = U.section(title, back); page.classList.add('pu-screen', 'pd-screen', 'pd-screen--' + mode); return page;
  }
  function mount(page, mode) {
    const scroll = U.root.scrollTop;
    const same = U.root.dataset.view === mode && U.root.dataset.delivery === selected;
    const field = document.activeElement;
    const restore = same && field?.id === 'pd-problem-reason' ? [field.selectionStart, field.selectionEnd] : null;
    U.mount(page, mode); U.root.dataset.delivery = selected; U.root.scrollTop = same ? scroll : 0;
    if (restore) {
      const input = document.getElementById('pd-problem-reason');
      input?.focus({ preventScroll: true }); input?.setSelectionRange(...restore);
    }
  }
  function list() {
    const page = section('Entregas', () => C.partnerHome.open('partner-home'), 'list');
    const rows = C.partnerData.pendingDeliveries();
    const summary = U.node('div', null, 'pu-summary');
    const count = key => rows.filter(row => row.delivery_status === key).length;
    const labels = [[count('pending'), 'a preparar'], [count('dispatched'), 'em rota'], [count('failed'), 'com problema']];
    summary.append(U.node('strong', rows.length + (rows.length === 1 ? ' entrega pendente' : ' entregas pendentes')),
      U.node('p', rows.length ? labels.filter(([n]) => n).map(([n, label]) => n + ' ' + label).join(' • ') : 'Nenhuma entrega pendente.'));
    page.appendChild(summary);
    if (C.partnerData.state.errors.includes('deliveries')) {
      page.appendChild(U.node('p', 'Não consegui atualizar as entregas.', 'ps-error'));
      page.appendChild(U.button('TENTAR DE NOVO', () => void C.partnerData.load(), 'secondary'));
    }
    rows.forEach(row => {
      const card = U.plate('pu-order pd-order'); card.appendChild(identity(row, true));
      const lines = U.node('div', null, 'pd-order-items');
      items(row).forEach(item => lines.appendChild(U.node('p', size(item) + ' • ' + quantity(item))));
      card.appendChild(lines);
      const button = U.button('VER ENTREGA', () => {
        leave(); selected = row.order_id; payment = ''; paying = false; reporting = false; problemReason = ''; error = ''; C.partnerHome.open('partner-delivery');
      });
      button.appendChild(C.createSvg([{ d: 'M4 12h16m-6-6 6 6-6 6' }]));
      card.appendChild(button); page.appendChild(card);
    });
    mount(page, 'deliveries');
  }
  function photoFrame(row, item) {
    const frame = U.node('div', null, 'pu-tire-photo pd-photo');
    frame.append(U.icon('camera'), U.node('span', 'Sem foto'));
    // Nunca usa a foto genérica do pedido para representar pneus diferentes.
    if (!item.photo_request_id) return frame;
    const key = row.order_id + '/' + item.photo_request_id;
    let entry = photos.get(key);
    if (!entry) {
      entry = { url: '', failed: false, controller: new AbortController() }; photos.set(key, entry);
      const session = C.sessionFingerprint(), current = generation;
      void (async () => {
        try {
          const path = 'operacao/entregas/fotos/' + encodeURIComponent(item.photo_request_id);
          const response = await C.authenticatedFetch(C.operationPath(path), { signal: entry.controller.signal });
          if (!response.ok) throw new Error('photo_unavailable');
          const blob = await response.blob();
          if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw new Error('photo_unavailable');
          if (current !== generation || session !== C.sessionFingerprint()) return;
          entry.url = URL.createObjectURL(blob);
        } catch { entry.failed = true; }
        if (current === generation && session === C.sessionFingerprint() && C.partnerHome.currentTab() === 'partner-delivery') render();
      })();
    }
    if (entry.url) {
      const image = U.node('img'); image.alt = 'Foto do pneu ' + size(item); image.src = entry.url;
      image.addEventListener('error', () => { URL.revokeObjectURL(entry.url); entry.url = ''; entry.failed = true; render(); });
      frame.replaceChildren(image);
    } else if (!entry.failed) frame.replaceChildren(U.node('span', 'Carregando…'));
    return frame;
  }
  function products(row) {
    const card = U.plate('pd-products');
    items(row).forEach(item => {
      const line = U.node('div', null, 'pd-product'), copy = U.node('div', null, 'pd-product-copy');
      copy.append(U.node('strong', size(item) + ' • ' + quantity(item)),
        U.node('p', [item.brand, U.condition(item.tire_condition)].filter(Boolean).join(' • ')));
      line.append(photoFrame(row, item), copy); card.appendChild(line);
    });
    if (!items(row).length) card.appendChild(U.node('p', 'Os itens deste pedido precisam ser conferidos.', 'ps-copy'));
    return card;
  }
  function address(row) {
    const card = U.plate('pd-address'), line = U.node('div', null, 'pd-address-copy');
    line.append(C.createSvg([{ d: 'M12 22S4 14 4 9a8 8 0 1 1 16 0c0 5-8 13-8 13ZM12 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', fill: 'currentColor', stroke: 'none', 'fill-rule': 'evenodd' }]),
      U.node('strong', row.delivery_address || 'Endereço não informado'));
    card.appendChild(line);
    if (row.delivery_address) {
      const link = U.node('a', null, 'ps-button ps-button--secondary pd-route');
      link.href = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(row.delivery_address);
      link.target = '_blank'; link.rel = 'noopener';
      link.append(C.createSvg([{ d: 'm3 10 19-8-8 19-3-8-8-3Z', fill: 'currentColor', stroke: 'none' }]), U.node('span', 'ABRIR ROTA'));
      card.appendChild(link);
    }
    return card;
  }
  function paymentChoice() {
    const card = U.plate('pd-payment'); card.appendChild(U.node('h4', 'Como o cliente pagou?', 'pu-label'));
    const choices = U.node('div', null, 'pd-payment-choices'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'Forma de pagamento');
    ['Pix', 'Dinheiro', 'Cartão'].forEach(method => {
      const button = U.button(method, () => { payment = method; error = ''; render(); }, payment === method ? 'primary' : 'secondary');
      button.setAttribute('aria-pressed', String(payment === method)); choices.appendChild(button);
    });
    card.append(choices, U.node('p', 'Confirme após entregar os pneus e receber o valor.', 'pu-helper')); return card;
  }
  async function save(row, next) {
    if (busy) return;
    if (next === 'delivered' && !payment) { error = 'Escolha como recebeu.'; return render(); }
    if (next === 'failed' && (!reporting || !mine(row) || row.delivery_status !== 'dispatched')) return;
    if (next === 'failed' && !problemReason.trim()) { error = 'Informe o que aconteceu na entrega.'; return render(); }
    if (next === 'failed' && problemReason.trim().length > 500) { error = 'Use até 500 caracteres no motivo.'; return render(); }
    busy = true; error = ''; render();
    const session = C.sessionFingerprint();
    try {
      const courier = C.stored(C.keys.name);
      const result = await C.partnerData.api('entregas/' + encodeURIComponent(row.order_id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delivery_status: next, delivery_courier: courier, payment_method: next === 'delivered' ? payment : null,
          ...(next === 'failed' ? { reason: problemReason.trim() } : {}) }),
      });
      if (session !== C.sessionFingerprint()) return;
      if (result.order_id !== row.order_id || result.delivery_status !== next) throw new Error('delivery_not_found');
      C.partnerData.state.deliveries = C.partnerData.state.deliveries.map(item => item.order_id === row.order_id
        ? { ...item, delivery_status: next, delivery_courier: courier } : item);
      paying = false; reporting = false; problemReason = ''; await C.partnerData.load();
      if (session === C.sessionFingerprint()) {
        C.showToast(next === 'failed' ? 'Problema registrado. Pneus continuam reservados.' : next === 'delivered' ? 'Entrega concluída.' : next === 'dispatched' ? 'Entrega iniciada.' : 'Entrega atribuída a você.');
        if (next === 'delivered') C.partnerHome.open(C.partnerData.pendingDeliveries().length ? 'partner-deliveries' : 'partner-home', true);
      }
    } catch (failure) { if (session === C.sessionFingerprint()) error = U.errorMessage(failure); }
    finally { if (session === C.sessionFingerprint()) { busy = false; C.partnerHome.render(); } }
  }
  function renderProblem(row) {
    const back = () => { if (!busy) { reporting = false; error = ''; render(); } };
    const page = section('Problema na entrega', back, 'problem');
    const customer = U.plate('pu-customer pd-customer'); customer.appendChild(identity(row, false)); page.appendChild(customer);
    const card = U.plate('pd-problem-form');
    const field = U.node('label', null, 'pd-problem-field');
    field.appendChild(U.node('span', 'O que aconteceu?'));
    const input = U.node('textarea'); input.id = 'pd-problem-reason'; input.rows = 4; input.maxLength = 500;
    input.value = problemReason; input.placeholder = 'Ex.: cliente ausente, endereço não encontrado…';
    input.setAttribute('aria-label', 'Motivo do problema'); input.required = true;
    input.addEventListener('input', () => {
      problemReason = input.value;
      if (error) { error = ''; U.root.querySelectorAll('.ps-error').forEach(el => el.remove()); }
    }); field.appendChild(input);
    card.append(field, U.node('p', 'Os pneus continuam reservados até a loja confirmar a devolução.', 'pu-helper'));
    page.appendChild(card);
    page.appendChild(U.button(busy ? 'REGISTRANDO…' : 'REGISTRAR PROBLEMA', () => void save(row, 'failed'), 'secondary'));
    page.appendChild(U.button('VOLTAR PARA ENTREGA', back, 'secondary'));
    if (error) { const el = U.node('p', error, 'ps-error'); el.setAttribute('role', 'alert'); page.appendChild(el); }
    page.querySelectorAll('button,textarea').forEach(el => { el.disabled = busy; }); mount(page, 'delivery-problem');
  }
  function render() {
    const row = C.partnerData.pendingDeliveries().find(item => item.order_id === selected);
    if (!row) return list();
    if (reporting && row.delivery_status === 'dispatched' && mine(row)) return renderProblem(row);
    reporting = false;
    const page = section(paying ? 'Confirmar entrega' : 'Entrega', () => {
      if (busy) return;
      if (paying) { paying = false; error = ''; render(); } else C.partnerHome.open('partner-deliveries');
    }, 'detail');
    if (!paying) page.querySelectorAll('.ps-screen-heading')[0].appendChild(badge(row));
    page.appendChild(U.node('h4', 'Quem vai receber', 'pu-label'));
    const customer = U.plate('pu-customer pd-customer'); customer.appendChild(identity(row, false)); page.appendChild(customer);
    if (!paying) {
      page.append(U.node('h4', items(row).length === 1 ? 'Qual pneu levar' : 'Quais pneus levar', 'pu-label'), products(row),
        U.node('h4', 'Onde entregar', 'pu-label'), address(row));
    }
    const charge = U.node('div', null, 'pu-plate pd-charge');
    charge.append(U.node('span', 'Cobrar na entrega'), U.node('strong', C.currency.format(Number(row.total_amount || 0)))); page.appendChild(charge);
    if (paying && row.delivery_status === 'dispatched' && mine(row)) {
      page.appendChild(paymentChoice());
      page.appendChild(U.button(busy ? 'CONCLUINDO…' : 'CONFIRMAR ENTREGA', () => void save(row, 'delivered'), 'primary', 'check'));
    } else if (row.delivery_status === 'pending' && !row.delivery_courier) {
      page.appendChild(U.button(busy ? 'ASSUMINDO…' : 'ASSUMIR ENTREGA', () => void save(row, 'pending'), 'primary', 'delivery'));
    } else if (row.delivery_status === 'pending' && mine(row)) {
      page.appendChild(U.button(busy ? 'INICIANDO…' : 'INICIAR ENTREGA', () => void save(row, 'dispatched'), 'primary', 'delivery'));
    } else if (row.delivery_status === 'dispatched' && mine(row)) {
      page.appendChild(U.button('ENTREGUEI E RECEBI', () => { paying = true; error = ''; render(); }, 'primary', 'check'));
      const problem = U.button('PROBLEMA NA ENTREGA', () => { reporting = true; paying = false; error = ''; render(); }, 'secondary');
      problem.classList.add('pd-problem-button');
      problem.prepend(C.createSvg([{ d: 'M12 3 2 21h20L12 3ZM12 9v5m0 3v1' }])); page.appendChild(problem);
    } else {
      page.appendChild(U.info(row.delivery_status === 'failed' ? 'Entrega não concluída' : 'Entregador', row.delivery_status === 'failed'
        ? 'A reserva continua protegida. Procure o responsável da loja.' : row.delivery_courier || 'Não informado'));
    }
    if (error) { const el = U.node('p', error, 'ps-error'); el.setAttribute('role', 'alert'); page.appendChild(el); }
    page.querySelectorAll('button').forEach(el => { el.disabled = busy; });
    mount(page, paying ? 'delivery-payment' : 'delivery');
  }
  function leave() {
    ++generation; photos.forEach(entry => { entry.controller.abort(); if (entry.url) URL.revokeObjectURL(entry.url); }); photos.clear();
  }
  function reset() { leave(); selected = ''; paying = false; reporting = false; problemReason = ''; payment = ''; busy = false; error = ''; }
  C.partnerDeliveries = { list, render, reset, leave, busy: () => busy };
}());
