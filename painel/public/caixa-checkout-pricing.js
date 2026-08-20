(function () {
  'use strict';

  const Caixa = window.Caixa;

  function parseNegotiatedPrice(value) {
    let normalized = String(value || '').trim().replace(/R\$|\s/g, '');
    if (normalized.includes(',') && normalized.includes('.')) normalized = normalized.replace(/\./g, '');
    normalized = normalized.replace(',', '.');
    const price = Number(normalized);
    if (!Number.isFinite(price) || price <= 0 || price > 99_999_999.99) return null;
    const cents = Math.round(price * 100);
    if (Math.abs(price * 100 - cents) >= 1e-7) return null;
    return cents / 100;
  }

  Caixa.createCheckoutPricing = function (checkout, ui, productTitle, renderCart) {
    function cartTotals() {
      let quantity = 0;
      let total = 0;
      let valid = true;
      checkout.cart.forEach(function (line) {
        quantity += line.quantity;
        const price = Number(line.negotiatedPrice);
        if (!Number.isFinite(price) || price <= 0) valid = false;
        else total += price * line.quantity;
      });
      return { quantity: quantity, total: Math.round(total * 100) / 100, valid: valid };
    }

    function updateReviewSummary() {
      const totals = cartTotals();
      const amount = ui.reviewContent.querySelector('[data-checkout-review-total]');
      if (amount) amount.textContent = totals.valid ? Caixa.currency.format(totals.total) : 'Revise os preços';
      ui.confirmButton.disabled = checkout.busy || !totals.valid || totals.quantity === 0;
      ui.submitError.textContent = totals.valid ? '' : 'Informe um preço negociado válido para todos os itens.';
    }

    function reviewRow(line) {
      const row = document.createElement('div'); row.className = 'checkout-review-line';
      const copy = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = line.quantity + '× ' + productTitle(line.product);
      const description = document.createElement('small'); description.textContent = line.product.product_name;
      const official = document.createElement('small'); official.className = 'checkout-reference-price';
      official.textContent = 'Preço oficial: ' + Caixa.currency.format(Number(line.referencePrice));
      copy.append(name, description, official);
      const editor = document.createElement('label'); editor.className = 'checkout-negotiated-price';
      const label = document.createElement('span'); label.textContent = 'Preço negociado';
      const field = document.createElement('span');
      const currency = document.createElement('b'); currency.textContent = 'R$';
      const input = document.createElement('input');
      input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off';
      input.value = Number(line.negotiatedPrice).toFixed(2).replace('.', ',');
      input.setAttribute('aria-label', 'Preço negociado de ' + productTitle(line.product));
      field.append(currency, input); editor.append(label, field);
      const amount = document.createElement('strong'); amount.className = 'checkout-negotiated-total';
      amount.textContent = Caixa.currency.format(Number(line.negotiatedPrice) * line.quantity);
      input.addEventListener('input', function () {
        const price = parseNegotiatedPrice(input.value);
        line.negotiatedPrice = price; checkout.idempotencyKey = null;
        input.classList.toggle('invalid', price == null);
        amount.textContent = price == null ? 'Preço inválido' : Caixa.currency.format(price * line.quantity);
        updateReviewSummary(); renderCart();
      });
      input.addEventListener('blur', function () {
        if (line.negotiatedPrice != null) input.value = Number(line.negotiatedPrice).toFixed(2).replace('.', ',');
      });
      row.append(copy, editor, amount);
      return row;
    }

    return { cartTotals: cartTotals, reviewRow: reviewRow, updateReviewSummary: updateReviewSummary };
  };
}());
