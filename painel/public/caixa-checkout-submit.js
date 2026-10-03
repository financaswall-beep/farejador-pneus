(function () {
  'use strict';
  const C = window.Caixa, runtime = C.checkoutRuntime;
  const checkout = runtime.state, ui = runtime.ui;
  const pendingMessage = 'Não foi possível confirmar se a venda entrou. Toque em Verificar venda antes de refazer.';

  function storageKey() {
    return '2w_checkout_attempt:' + JSON.stringify([C.scope(), C.slug(), C.stored(C.keys.user)]);
  }
  function saveAttempt(body) {
    const attempt = { body: body, cart: Array.from(checkout.cart.entries()),
      payment: checkout.payment, customerName: checkout.customerName, customerPhone: checkout.customerPhone };
    // Se o navegador não conseguir preservar a tentativa, não envia a venda.
    sessionStorage.setItem(storageKey(), JSON.stringify(attempt));
    checkout.pendingAttempt = attempt;
    return attempt;
  }
  function restoreAttempt() {
    const saved = sessionStorage.getItem(storageKey());
    if (!saved) return;
    try {
      const attempt = JSON.parse(saved);
      if (!attempt.body?.idempotency_key || !Array.isArray(attempt.cart)) throw new Error('invalid_attempt');
      checkout.pendingAttempt = attempt;
      checkout.cart = new Map(attempt.cart);
      checkout.idempotencyKey = attempt.body.idempotency_key;
      checkout.payment = attempt.payment;
      checkout.customerName = attempt.customerName;
      checkout.customerPhone = attempt.customerPhone;
      ui.submitError.textContent = pendingMessage;
      runtime.renderCart();
      C.showToast('Há uma venda aguardando conferência. Toque em Verificar venda.');
    } catch (_) {
      checkout.recoveryBlocked = true;
      C.showToast('Não foi possível recuperar a tentativa. Confira a venda com o responsável antes de continuar.');
    }
  }
  async function finish(payload, key, saleSession) {
    sessionStorage.removeItem(key);
    if (saleSession !== C.sessionFingerprint()) return;
    checkout.pendingAttempt = null;
    checkout.cart.clear(); checkout.idempotencyKey = null;
    C.elements.checkoutReviewModal.classList.add('hidden');
    runtime.renderCart();
    await C.loadCatalog();
    if (!C.isPartner()) void C.loadSales();
    if (!C.isPartner() && payload.receipt) {
      C.elements.receiptModal.classList.remove('hidden');
      C.renderReceipt(payload.receipt);
    }
    C.showToast(payload.status === 'cancelled' ? 'Esta venda já foi registrada e cancelada. Confira o histórico.'
      : 'Venda registrada, estoque baixado e financeiro atualizado.');
  }
  async function confirmSale() {
    if (checkout.busy || checkout.recoveryBlocked || checkout.cart.size === 0 || !runtime.cartTotals().valid) return;
    const saleSession = C.sessionFingerprint();
    if (C.checkoutSessionChanged(saleSession)) {
      C.resetCheckout(); C.showToast('A conta mudou. O carrinho anterior foi limpo.'); return;
    }
    const key = storageKey(), recovering = Boolean(checkout.pendingAttempt);
    checkout.busy = true;
    ui.submitError.textContent = ''; ui.confirmButton.disabled = true;
    ui.confirmButton.textContent = recovering ? 'VERIFICANDO…' : 'REGISTRANDO…';
    runtime.renderCart();
    let response;
    try {
      if (!checkout.pendingAttempt) {
        checkout.idempotencyKey ||= 'caixa-' + window.crypto.randomUUID();
        saveAttempt(C.saleRequestBody(checkout, runtime.cartTotals()));
      }
      const attempt = checkout.pendingAttempt;
      if (recovering) {
        const lookup = C.operationPath('vendas/por-chave/', '/api/caixa/vendas/por-chave/')
          + encodeURIComponent(attempt.body.idempotency_key);
        const checked = await C.authenticatedFetch(lookup);
        const found = await C.json(checked);
        if (!checked.ok) throw new Error('verification_unavailable');
        if (saleSession !== C.sessionFingerprint()) return;
        if (found.found) { await finish(found, key, saleSession); return; }
      }
      // Mesmo corpo e mesma chave após timeout, reload ou troca de rede.
      response = await C.authenticatedFetch(C.operationPath('vendas', '/api/caixa/vendas'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attempt.body),
      });
      const payload = await C.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      if (!payload.order_id) throw new Error('confirmation_missing');
      await finish(payload, key, saleSession);
    } catch (failure) {
      if (saleSession !== C.sessionFingerprint()) return;
      // Uma resposta perdida nunca autoriza uma chave nova. Na primeira
      // tentativa apenas uma rejeição explícita do servidor libera edição.
      const definitive = !recovering && response && [400, 403, 404, 409, 422].includes(response.status)
        && !/idempotency|confirmation_missing/.test(failure.message);
      if (definitive) {
        sessionStorage.removeItem(key); checkout.pendingAttempt = null;
        ui.submitError.textContent = runtime.submitErrorMessage(failure.message);
        void C.loadCatalog();
      } else if (checkout.pendingAttempt) ui.submitError.textContent = pendingMessage;
      else ui.submitError.textContent = 'Não foi possível salvar a tentativa neste navegador. A venda não foi enviada.';
    } finally {
      if (saleSession === C.sessionFingerprint()) {
        checkout.busy = false; ui.confirmButton.disabled = false;
        ui.confirmButton.textContent = checkout.pendingAttempt ? 'VERIFICAR VENDA' : 'CONFIRMAR VENDA';
        runtime.renderCart();
      }
    }
  }
  C.confirmCheckoutSale = confirmSale;
  C.restoreCheckoutAttempt = restoreAttempt;
  C.checkoutPendingMessage = pendingMessage;
}());
