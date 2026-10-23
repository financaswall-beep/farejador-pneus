(function () {
  'use strict';
  const C = window.Caixa;
  C.createMatrixDeliveryActions = function (state, ui, paint) {
    const byId = ui.byId;
    async function api(method, path, body) {
      const options = { method, headers: {} };
      if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
      const response = await C.authenticatedFetch('/api/caixa/entregas/' + path, options);
      const payload = await C.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed'); return payload;
    }
    const messages = {
      trip_has_unresolved_deliveries: 'Finalize ou informe todas as paradas antes de encerrar.',
      trip_already_open: 'Você já tem uma rota aberta. Atualize para continuar.',
      delivery_not_found: 'O pedido mudou ou não pertence à sua rota. Atualize a lista.',
      receipt_belongs_to_expense: 'Este comprovante já está no Financeiro. Confira o lançamento por lá.',
      receipt_exact_duplicate: 'Este arquivo já foi usado em outro comprovante.',
      trip_not_found: 'A rota não está mais aberta. Atualize para continuar.',
      invalid_number: 'Confira o KM e os valores informados.',
    };
    async function run(work, success) {
      if (state.busy || state.loading || state.session !== C.sessionFingerprint() || C.isPartner()) return false;
      const session = C.sessionFingerprint(); const generation = state.generation;
      state.busy = true; state.error = ''; paint();
      try {
        await work();
        if (session !== C.sessionFingerprint() || generation !== state.generation) return false;
        if (success) await success(); return true;
      } catch (error) {
        if (session === C.sessionFingerprint() && generation === state.generation && error.message !== 'invalid_session') {
          state.error = messages[error.message] || 'Não foi possível concluir. Confira os dados e tente novamente.';
          if (byId('delivery-failure-modal').open) byId('delivery-failure-error').textContent = state.error;
        }
        return false;
      } finally {
        if (session === C.sessionFingerprint() && generation === state.generation) { state.busy = false; paint(); }
      }
    }
    const row = id => state.rows.find(item => item.order_id === id);
    function number(id, max) {
      const input = byId(id); if (input.value === '') return null;
      const value = Number(input.value);
      if (!input.checkValidity() || !Number.isFinite(value) || value < 0 || value > max) throw new Error('invalid_number');
      return value;
    }
    async function openRoute() {
      if (state.route || !state.selected.size) return;
      const selected = [...state.selected];
      if (selected.some(id => !state.rows.some(item => item.order_id === id && !item.in_route && item.delivery_status === 'pending'))) return;
      await run(() => api('POST', 'rota/abrir', { order_ids: selected, km_start: number('matrix-route-km-start', 9999999) }), async () => {
        state.selected.clear(); byId('matrix-route-km-start').value = ''; state.view = 'route';
        await state.reload(); C.showToast('Rota montada. Inicie cada entrega quando sair.'); ui.focus();
      });
    }
    async function dispatch(id) {
      const current = row(id); if (!current?.in_route || current.delivery_status !== 'pending') return;
      await run(() => api('POST', 'status', { order_id: id, status: 'dispatched', payment_method: null }), async () => {
        await state.reload(); C.showToast('Saída desta entrega registrada.');
      });
    }
    async function confirmPayment() {
      const current = row(state.paymentOrderId);
      if (!state.route || !current?.in_route || current.delivery_status !== 'dispatched'
        || typeof current.total_amount !== 'number' || !Number.isFinite(current.total_amount) || current.total_amount < 0
        || !['pix', 'cartao', 'dinheiro'].includes(state.paymentMethod) || !state.received) return;
      const request = { order_id: current.order_id, status: 'delivered', payment_method: state.paymentMethod };
      await run(() => api('POST', 'status', request), async () => {
        state.paymentOrderId = null; state.paymentMethod = null; state.received = false; state.view = 'route';
        await state.reload(); C.showToast('Entrega e pagamento registrados.'); ui.focus();
      });
    }
    let returnFocus = null;
    function openFailure(id) {
      const current = row(id);
      if (state.busy || !current?.in_route || !['pending', 'dispatched'].includes(current.delivery_status)) return;
      state.failingOrderId = id; returnFocus = document.activeElement;
      byId('delivery-failure-reason').value = ''; byId('delivery-failure-error').textContent = '';
      byId('mdf-failure-order').textContent = 'Pedido ' + ui.orderLabel(current);
      const modal = byId('delivery-failure-modal'); modal.classList.remove('hidden'); modal.showModal(); byId('delivery-failure-reason').focus();
    }
    function closeFailure(force) {
      if (state.busy && !force) return;
      const modal = byId('delivery-failure-modal'); if (modal.open) modal.close();
      modal.classList.add('hidden'); state.failingOrderId = null;
      if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = null;
    }
    async function submitFailure() {
      const id = state.failingOrderId; const reason = byId('delivery-failure-reason').value.trim();
      if (!id || !row(id)?.in_route) return;
      if (!reason) { byId('delivery-failure-error').textContent = 'Conte o motivo para registrar.'; return; }
      await run(() => api('POST', 'nao-entregue', { order_id: id, reason }), async () => {
        closeFailure(true); await state.reload(); C.showToast('Problema informado ao escritório.'); ui.focus();
      });
    }
    async function uploadReceipt() {
      const input = byId('matrix-route-receipt'); const file = input.files?.[0];
      if (!file || !state.route || state.busy) return;
      byId('matrix-route-receipt-status').textContent = 'Enviando comprovante…';
      const ok = await run(async () => {
        const response = await C.authenticatedFetch('/api/caixa/entregas/rota/comprovante', {
          method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file,
        });
        const payload = await C.json(response); if (!response.ok) throw new Error(payload.error || 'receipt_upload_failed');
      }, () => { byId('matrix-route-receipt-status').textContent = '✓ Comprovante enviado para conferência.'; });
      if (!ok && state.session === C.sessionFingerprint()) byId('matrix-route-receipt-status').textContent = 'O comprovante não foi enviado. Tente novamente.';
      input.value = '';
    }
    async function closeRoute() {
      if (!state.route || state.route.unresolved > 0) return;
      await run(() => api('POST', 'rota/fechar', {
        km_end: number('matrix-route-km-end', 9999999), fuel_spent: number('matrix-route-fuel', 99999),
      }), async () => {
        byId('matrix-route-km-end').value = ''; byId('matrix-route-fuel').value = '';
        byId('matrix-route-receipt-status').textContent = ''; state.view = 'prepare';
        await state.reload(); state.notice = '✓ Rota encerrada e registrada.'; C.showToast('Rota encerrada.'); ui.focus();
      });
    }
    byId('matrix-route-open').addEventListener('click', openRoute);
    byId('mdf-payment-confirm').addEventListener('click', confirmPayment);
    byId('matrix-route-close-button').addEventListener('click', closeRoute);
    byId('matrix-route-receipt').addEventListener('change', uploadReceipt);
    byId('delivery-failure-submit').addEventListener('click', submitFailure);
    document.querySelectorAll('[data-close-delivery-failure]').forEach(button => button.addEventListener('click', () => closeFailure(false)));
    byId('delivery-failure-modal').addEventListener('cancel', event => { event.preventDefault(); closeFailure(false); });
    return { dispatch, openFailure, closeFailure };
  };
}());
