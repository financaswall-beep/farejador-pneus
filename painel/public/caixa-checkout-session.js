(function () {
  'use strict';

  const Caixa = window.Caixa;
  const runtime = Caixa.checkoutRuntime;
  const checkout = runtime.state;
  const ui = runtime.ui;
  let checkoutSession = '';

  function selectDefault(buttons, dataKey, expected, ariaAttribute) {
    buttons.forEach(function (button) {
      const active = button.dataset[dataKey] === expected;
      button.classList.toggle('active', active);
      button.setAttribute(ariaAttribute, String(active));
    });
  }

  function resetCheckout() {
    if (checkout.request) checkout.request.abort();
    window.clearTimeout(checkout.searchTimer);
    checkout.type = 'tire';
    checkout.products = [];
    checkout.cart.clear();
    checkout.payment = 'pix';
    checkout.customerName = 'Cliente Balcão';
    checkout.customerPhone = '';
    checkout.idempotencyKey = null;
    checkout.busy = false;
    checkout.request = null;
    ui.search.value = '';
    ui.searchClear.classList.add('hidden');
    ui.submitError.textContent = '';
    ui.confirmButton.disabled = false;
    ui.confirmButton.textContent = 'CONFIRMAR VENDA';
    selectDefault(ui.typeButtons, 'catalogType', 'tire', 'aria-pressed');
    selectDefault(ui.paymentButtons, 'payment', 'pix', 'aria-checked');
    Caixa.elements.customerModal.classList.add('hidden');
    Caixa.elements.checkoutReviewModal.classList.add('hidden');
    runtime.renderCatalog([]);
    runtime.renderCart();
    checkoutSession = '';
  }

  function bindCheckoutSession(fingerprint) {
    resetCheckout();
    checkoutSession = fingerprint;
  }

  function checkoutSessionChanged(fingerprint) {
    return !checkoutSession || checkoutSession !== fingerprint;
  }

  Object.assign(Caixa, {
    resetCheckout: resetCheckout,
    bindCheckoutSession: bindCheckoutSession,
    checkoutSessionChanged: checkoutSessionChanged,
  });
}());
