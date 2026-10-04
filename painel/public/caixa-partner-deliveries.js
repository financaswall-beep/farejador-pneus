(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  let selected = '';
  let paying = false;
  let payment = '';
  let busy = false;
  let error = '';
  function mine(row) {
    return String(row.delivery_courier || '').trim().toLocaleLowerCase('pt-BR') === String(C.stored(C.keys.name) || '').trim().toLocaleLowerCase('pt-BR');
  }
  function status(row) {
    return ({ pending: 'A preparar', dispatched: 'Em rota', failed: 'Entrega com problema' })[row.delivery_status] || '';
  }
  function list() {
    const page = U.section('Entregas', () => C.partnerHome.open('partner-home'));
    const rows = C.partnerData.pendingDeliveries();
    if (!rows.length) page.appendChild(U.node('p', 'Nenhuma entrega pendente.', 'ps-copy'));
    rows.forEach(row => {
      const item = U.node('article', null, 'ps-order-row');
      item.append(U.node('h4', U.orderLabel(row)), U.node('p', status(row)), U.node('p', row.customer_name || 'Cliente'), U.items(row.items));
      item.appendChild(U.button('VER ENTREGA', () => {
        selected = row.order_id; payment = ''; paying = false; error = ''; C.partnerHome.open('partner-delivery');
      }, 'primary', 'delivery')); page.appendChild(item);
    });
    U.mount(page, 'deliveries');
  }
  async function save(row, next) {
    if (busy) return;
    if (next === 'delivered' && !payment) { error = 'Escolha como recebeu.'; return render(); }
    busy = true; error = ''; render();
    const session = C.sessionFingerprint();
    try {
      await C.partnerData.api('entregas/' + encodeURIComponent(row.order_id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delivery_status: next, delivery_courier: C.stored(C.keys.name), payment_method: next === 'delivered' ? payment : null }),
      });
      if (session !== C.sessionFingerprint()) return;
      paying = false; await C.partnerData.load();
      if (session === C.sessionFingerprint()) {
        C.showToast(next === 'delivered' ? 'Entrega concluída.' : next === 'dispatched' ? 'Entrega iniciada.' : 'Entrega atribuída a você.');
        if (next === 'delivered') C.partnerHome.open('partner-home', true);
      }
    } catch (failure) { if (session === C.sessionFingerprint()) error = U.errorMessage(failure); }
    finally { if (session === C.sessionFingerprint()) { busy = false; C.partnerHome.render(); } }
  }
  function render() {
    const row = C.partnerData.pendingDeliveries().find(item => item.order_id === selected);
    if (!row) return list();
    const page = U.section(paying ? 'Entreguei e recebi' : 'Entrega', () => {
      if (busy) return;
      if (paying) { paying = false; render(); } else C.partnerHome.open('partner-deliveries');
    });
    page.append(U.node('strong', U.orderLabel(row), 'ps-order-code'), U.node('p', row.customer_name || 'Cliente', 'ps-customer'), U.node('p', status(row), 'ps-copy'), U.items(row.items));
    page.appendChild(U.info('Endereço', row.delivery_address || 'Endereço não informado', 'delivery'));
    page.appendChild(U.info('Cobrar na entrega', C.currency.format(Number(row.total_amount || 0))));
    if (paying) {
      page.appendChild(U.payment(payment || row.payment_method, value => { payment = value; }));
      page.appendChild(U.button(busy ? 'CONCLUINDO…' : 'CONFIRMAR ENTREGA', () => void save(row, 'delivered'), 'primary', 'check'));
    } else if (row.delivery_status === 'pending' && !row.delivery_courier) {
      page.appendChild(U.button('ASSUMIR ENTREGA', () => void save(row, 'pending'), 'primary', 'delivery'));
    } else if (row.delivery_status === 'pending' && mine(row)) {
      page.appendChild(U.button('INICIAR ENTREGA', () => void save(row, 'dispatched'), 'primary', 'delivery'));
    } else if (row.delivery_status === 'dispatched' && mine(row)) {
      if (row.delivery_address) {
        const link = U.node('a', 'ABRIR ROTA', 'ps-button ps-button--secondary');
        link.href = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(row.delivery_address);
        link.target = '_blank'; link.rel = 'noopener'; page.appendChild(link);
      }
      page.appendChild(U.button('ENTREGUEI E RECEBI', () => { paying = true; render(); }, 'primary', 'check'));
    } else {
      page.appendChild(U.info(row.delivery_status === 'failed' ? 'Entrega não concluída' : 'Entregador', row.delivery_status === 'failed' ? 'A reserva continua protegida. Procure o responsável da loja.' : row.delivery_courier || 'Não informado'));
    }
    if (error) { const el = U.node('p', error, 'ps-error'); el.setAttribute('role', 'alert'); page.appendChild(el); }
    page.querySelectorAll('button,select').forEach(el => { el.disabled = busy; });
    U.mount(page, 'delivery');
  }
  function reset() { selected = ''; paying = false; payment = ''; busy = false; error = ''; }
  C.partnerDeliveries = { list, render, reset, busy: () => busy };
}());
