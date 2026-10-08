(function () {
  'use strict';
  const C = window.Caixa, U = C.partnerUI, V = C.partnerBuyUI;
  let rows = [], loaded = false, loading = false, opened = false, sending = false, error = '', generation = 0, mount = null;
  const receipts = new Map();
  const allowed = () => C.isPartner() && C.token() && C.canModule('estoque');
  const canReceive = () => allowed() && (C.stored(C.keys.role) === 'owner' || C.canModule('compras'));
  function status(row) {
    if (row.receipt_status === 'received') return row.payment_status === 'paid' ? 'Recebido · pago' : 'Recebido · pagamento pendente';
    return ({requested:'Aguardando aprovação',approved:'Em separação',dispatched:'Enviado para sua loja',rejected:'Recusado pela 2W'})[row.status] || '';
  }
  async function load() {
    if (!allowed() || loading) return;
    const version = generation, session = C.sessionFingerprint();
    loading = true; error = ''; render(mount);
    try {
      const result = await C.partnerData.api('operacao/comprar/pedidos');
      if (version !== generation || session !== C.sessionFingerprint()) return;
      rows = result.rows || []; loaded = true;
    } catch (_) {
      if (version !== generation || session !== C.sessionFingerprint()) return;
      error = 'Não consegui atualizar seus pedidos. Tente novamente.';
    } finally {
      if (version === generation && session === C.sessionFingerprint()) { loading = false; render(mount); }
    }
  }
  function render(target) {
    mount = target;
    if (!target || !allowed()) return;
    target.replaceChildren();
    const toggle = V.control(opened ? 'FECHAR MEUS PEDIDOS' : 'MEUS PEDIDOS', () => {
      if (sending) return;
      opened = !opened; render(target); if (opened) load();
    }, 'metal'); toggle.disabled = sending; target.appendChild(toggle);
    if (!opened) return;
    const refresh = V.control(loading ? 'ATUALIZANDO…' : 'ATUALIZAR PEDIDOS', load, 'metal');
    refresh.disabled = loading || sending; target.appendChild(refresh);
    if (error) target.appendChild(U.node('p', error, 'ps-buy-message ps-buy-error'));
    if (!loaded) { target.appendChild(U.node('p', 'Buscando seus pedidos…', 'ps-buy-message')); return; }
    if (!rows.length) target.appendChild(U.node('p', 'Você ainda não enviou pedidos.', 'ps-buy-message'));
    rows.forEach(row => {
      const card = U.node('article', null, 'ps-buy-order');
      card.append(U.node('h4', row.request_number), U.node('strong', status(row), 'ps-buy-order-status'));
      const receive = row.status === 'dispatched' && row.receipt_status !== 'received' && canReceive();
      const form = receipts.get(row.id) || {key:'',items:(row.items || []).map(item => ({item_id:item.item_id,received_quantity:Number(item.quantity)}))};
      receipts.set(row.id, form);
      (row.items || []).forEach(item => {
        const line = U.node('div', null, 'ps-buy-order-item');
        line.append(U.node('b', item.measure), U.node('span', (item.brand || '') + ' · ' + item.quantity + ' enviado(s)'));
        if (receive) {
          const label = U.node('label', 'Quantos você recebeu?');
          const input = U.node('input'); input.type = 'number'; input.inputMode = 'numeric'; input.min = '0'; input.max = String(item.quantity); input.step = '1';
          input.value = String(form.items.find(i => i.item_id === item.item_id).received_quantity); input.disabled = sending;
          input.addEventListener('input', () => {
            form.items.find(i => i.item_id === item.item_id).received_quantity = input.value.trim() ? Number(input.value) : NaN; form.key = '';
          }); label.appendChild(input); line.appendChild(label);
        } else if (row.receipt_status === 'received') line.appendChild(U.node('span', item.received_quantity + ' recebido(s)'));
        card.appendChild(line);
      });
      const cents = row.settled_total_cents == null ? row.total_cents : row.settled_total_cents;
      card.appendChild(U.node('p', 'Total: ' + V.money(Number(cents)), 'ps-buy-order-total'));
      if (row.rejection_reason) card.appendChild(U.node('p', row.rejection_reason));
      if (receive) {
        card.appendChild(U.node('p', 'Confira os pneus. Confirmar recebimento não confirma pagamento.', 'ps-buy-cart-note'));
        const button = V.control(sending ? 'CONFIRMANDO…' : 'CONFIRMAR RECEBIMENTO', () => submit(row, form), 'primary', 'check');
        button.disabled = sending; card.appendChild(button);
      }
      target.appendChild(card);
    });
  }
  async function submit(row, form) {
    if (!canReceive() || sending) return;
    if (form.items.some(i => !Number.isInteger(i.received_quantity) || i.received_quantity < 0
      || i.received_quantity > Number(row.items.find(item => item.item_id === i.item_id).quantity))) {
      error = 'Informe uma quantidade entre zero e o total enviado.'; render(mount); return;
    }
    const version = generation, session = C.sessionFingerprint();
    form.key ||= window.crypto?.randomUUID?.() || 'recebimento-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    sending = true; error = ''; render(mount);
    try {
      await C.partnerData.api('operacao/comprar/pedidos/' + row.id + '/receber', {
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idempotency_key:form.key,items:form.items}),
      });
      if (version !== generation || session !== C.sessionFingerprint()) return;
      receipts.delete(row.id); C.showToast('Recebimento confirmado. Estoque atualizado.'); await load();
    } catch (_) {
      if (version !== generation || session !== C.sessionFingerprint()) return;
      error = 'Não consegui confirmar. Atualize os pedidos para conferir o recebimento.';
    } finally {
      if (version === generation && session === C.sessionFingerprint()) { sending = false; render(mount); }
    }
  }
  function reset() { ++generation; rows = []; loaded = loading = opened = sending = false; error = ''; mount = null; receipts.clear(); }
  C.partnerBuyOrders = {render,load,reset,busy:()=>sending,open:()=>{opened=true;C.partnerHome.open('partner-buy');load();}};
}());
