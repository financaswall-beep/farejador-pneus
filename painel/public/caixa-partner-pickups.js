(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  let selected = '';
  let payment = '';
  let cancel = false;
  let busy = false;
  let error = '';
  function list() {
    const page = U.section('Retiradas', () => C.partnerHome.open('partner-home'));
    const rows = C.partnerData.pendingPickups();
    if (!rows.length) page.appendChild(U.node('p', 'Nenhuma retirada pendente.', 'ps-copy'));
    rows.forEach(row => {
      const item = U.node('article', null, 'ps-order-row');
      item.append(U.node('h4', U.orderLabel(row)), U.node('p', row.customer_name || 'Cliente'), U.items(row.items));
      item.appendChild(U.button('CLIENTE CHEGOU', () => {
        selected = row.order_id; payment = ''; cancel = false; error = ''; C.partnerHome.open('partner-pickup');
      }, 'primary', 'pickup'));
      page.appendChild(item);
    });
    U.mount(page, 'pickups');
  }
  async function save(row, cancelling) {
    if (busy || (!cancelling && !payment)) { error = 'Escolha como recebeu.'; return render(); }
    busy = true; error = ''; render();
    const session = C.sessionFingerprint();
    try {
      const result = await C.partnerData.api('retiradas/' + encodeURIComponent(row.order_id), {
        method: cancelling ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cancelling ? { reason: 'Cliente não veio — cancelamento confirmado na Operação simples' } : { payment_method: payment }),
      });
      if (session !== C.sessionFingerprint()) return;
      if (cancelling && !result.cancelled) throw new Error('pickup_not_found');
      C.showToast(cancelling ? 'Reserva liberada.' : 'Venda concluída.');
      selected = ''; cancel = false;
      await C.partnerData.load();
      if (session === C.sessionFingerprint()) C.partnerHome.open('partner-home', true);
    } catch (failure) {
      if (session !== C.sessionFingerprint()) return;
      error = U.errorMessage(failure);
    } finally { if (session === C.sessionFingerprint()) { busy = false; C.partnerHome.render(); } }
  }
  function render() {
    const row = C.partnerData.pendingPickups().find(item => item.order_id === selected);
    if (!row) return list();
    const page = U.section(cancel ? 'Cliente não veio?' : 'Cliente chegou', () => {
      if (busy) return;
      if (cancel) { cancel = false; render(); } else C.partnerHome.open('partner-pickups');
    });
    page.append(U.node('strong', U.orderLabel(row), 'ps-order-code'), U.node('p', row.customer_name || 'Cliente', 'ps-customer'), U.items(row.items));
    const services = Array.isArray(row.pickup_services) ? row.pickup_services : [];
    const serviceTotal = services.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0) / 100;
    page.appendChild(U.info('Total a receber', C.currency.format(Number(row.total_amount || 0) + serviceTotal)));
    if (services.length) page.appendChild(U.node('p', 'Inclui os serviços já registrados no pedido.', 'ps-copy'));
    if (cancel) {
      page.appendChild(U.node('p', 'Cancelar este pedido e liberar os pneus?', 'ps-copy'));
      page.appendChild(U.button('SIM, CANCELAR', () => void save(row, true), 'danger', 'close'));
      page.appendChild(U.button('MANTER PEDIDO', () => { cancel = false; render(); }, 'secondary'));
    } else {
      page.appendChild(U.payment(payment || row.payment_method, value => { payment = value; }));
      page.appendChild(U.button(busy ? 'CONCLUINDO…' : 'ENTREGUEI E RECEBI', () => void save(row, false), 'primary', 'check'));
      page.appendChild(U.button('Cliente não veio', () => { cancel = true; error = ''; render(); }, 'secondary'));
    }
    if (error) { const el = U.node('p', error, 'ps-error'); el.setAttribute('role', 'alert'); page.appendChild(el); }
    page.querySelectorAll('button,select').forEach(el => { el.disabled = busy; });
    U.mount(page, 'pickup');
  }
  function reset() { selected = ''; payment = ''; cancel = false; busy = false; error = ''; }
  C.partnerPickups = { list, render, reset, busy: () => busy };
}());
