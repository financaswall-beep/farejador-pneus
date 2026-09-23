(function () {
  'use strict';
  const C = window.Caixa, el = id => document.getElementById(id);
  const icons = {
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    pencil: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z',
  };
  function node(tag, text, className) {
    const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n;
  }
  C.createCheckoutView = function (checkout, catalog, pricing, changeQuantity) {
    const picker = el('checkout-picker'), priceDialog = el('checkout-price-dialog'), rows = el('checkout-lines');
    let priceLine = null;
    function button(label, className, action, symbol) {
      const b = node('button', symbol ? '' : label, className); b.type = 'button'; b.setAttribute('aria-label', label);
      if (symbol) b.appendChild(C.createSvg([{ d: icons[symbol] }]));
      b.disabled = checkout.busy; b.addEventListener('click', action); return b;
    }
    function editPrice(line) {
      if (checkout.busy) return;
      priceLine = line; el('checkout-price-name').textContent = catalog.productTitle(line.product);
      el('checkout-price-reference').textContent = 'Preço oficial: ' + C.currency.format(line.referencePrice);
      el('checkout-price-field').replaceChildren(pricing.priceEditor(line, refreshPrice));
      refreshPrice(); priceDialog.showModal(); priceDialog.querySelector('input').focus();
    }
    function refreshPrice() {
      const valid = priceLine?.negotiatedPrice != null && priceLine.negotiatedPrice > 0;
      el('checkout-price-error').hidden = valid; el('checkout-price-done').disabled = !valid;
    }
    function cartLine(line) {
      const product = line.product, card = node('article', '', 'co-line'); card.dataset.productId = product.product_id;
      card.appendChild(catalog.productImage(product));
      const body = node('div', '', 'co-line-body');
      body.append(node('strong', product.tire_size || product.product_name, 'co-line-title'), node('small', catalog.productDetails(product), 'co-line-meta'));
      const remove = button('Remover ' + catalog.productTitle(product), 'co-remove', () => changeQuantity(product, -line.quantity), 'trash');
      const price = button('Alterar preço de ' + catalog.productTitle(product), 'co-line-price', () => editPrice(line));
      price.textContent = '';
      price.append(node('b', line.negotiatedPrice == null ? 'Corrigir preço' : C.currency.format(line.negotiatedPrice)), node('span', '/ un.'), C.createSvg([{ d: icons.pencil }]));
      const footer = node('div', '', 'co-line-footer'), stepper = node('div', '', 'co-stepper');
      const minus = button('Diminuir quantidade de ' + catalog.productTitle(product), '', () => changeQuantity(product, -1)); minus.textContent = '−';
      const plus = button('Aumentar quantidade de ' + catalog.productTitle(product), '', () => changeQuantity(product, 1)); plus.textContent = '+';
      plus.disabled = checkout.busy || product.sellable === false || line.quantity >= (product.product_type === 'service' || product.stock_tracked === false ? 50 : Number(product.stock_quantity || 0));
      stepper.append(minus, node('span', String(line.quantity)), plus);
      footer.append(stepper, node('strong', line.negotiatedPrice == null ? '—' : C.currency.format(line.quantity * line.negotiatedPrice), 'co-line-total'));
      body.append(price, footer); card.append(body, remove); return card;
    }
    function render() {
      const total = pricing.cartTotals(), count = total.quantity + (total.quantity === 1 ? ' item' : ' itens');
      const focused = document.activeElement, focusedCard = focused?.closest('.co-line'), index = focusedCard ? Array.from(focusedCard.querySelectorAll('button')).indexOf(focused) : -1;
      rows.replaceChildren(...Array.from(checkout.cart.values(), cartLine));
      if (focusedCard && index >= 0) {
        const replacement = Array.from(rows.children).find(row => row.dataset.productId === focusedCard.dataset.productId);
        (replacement?.querySelectorAll('button')[index] || el('checkout-add-item')).focus({ preventScroll: true });
      }
      el('checkout-empty-cart').hidden = total.quantity > 0;
      el('checkout-picker-count').textContent = count + ' na venda';
      el('checkout-picker-total').textContent = total.valid ? C.currency.format(total.total) : 'Revise os preços';
      el('checkout-customer-caption').textContent = checkout.customerName === 'Cliente Balcão' ? 'Identifique se desejar' : 'Cliente identificado';
      ['checkout-add-item', 'checkout-customer-button'].forEach(id => { el(id).disabled = checkout.busy; });
      document.querySelectorAll('[data-payment], #checkout-review-content input').forEach(input => { input.disabled = checkout.busy; });
    }
    function close() { picker.close(); priceDialog.close(); }
    el('checkout-add-item').addEventListener('click', function () {
      if (checkout.busy) return;
      picker.showModal(); void C.loadCatalog();
    });
    ['checkout-picker-close', 'checkout-picker-done'].forEach(id => el(id).addEventListener('click', () => picker.close()));
    picker.addEventListener('click', event => { if (event.target === picker) picker.close(); });
    ['checkout-price-close', 'checkout-price-done'].forEach(id => el(id).addEventListener('click', () => priceDialog.close()));
    priceDialog.addEventListener('close', () => { priceLine = null; el('checkout-price-field').replaceChildren(); });
    return { render, close };
  };
}());
