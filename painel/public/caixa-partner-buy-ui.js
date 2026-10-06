(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  const paths = {
    car: 'M3 13l2-6h14l2 6v6H3ZM3 13h18M7 7l2-3h6l2 3M6 16h2m8 0h2M5 19v2m14-2v2',
    motorcycle: 'M7 17a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm17 0a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM3 17l5-8 6 8H3Zm5-8h8l4 8M15 4h3l2 8M6 6h4',
    trash: 'M4 7h16M9 7V3h6v4M6 7v14h12V7M10 11v6m4-6v6',
    cart: 'M2 3h3l3 13h12l2-10H6M9 20h.01M19 20h.01',
  };
  function icon(kind) {
    if (kind === 'cart') return C.createSvg([{d:'M2 2h3l.6 3H22l-2.5 10H8L5 4H2V2ZM9 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm9 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',fill:'currentColor',stroke:'none'}]);
    return paths[kind] ? C.createSvg([{ d: paths[kind] }]) : U.icon(kind);
  }
  function tireBadge() {
    const badge = U.node('span', null, 'ps-buy-tire-badge');
    badge.setAttribute('aria-hidden', 'true');
    badge.appendChild(C.createSvg([
      { d: 'M12 2C7 2 4 6.5 4 12s3 10 8 10 8-4.5 8-10S17 2 12 2Zm0 2c3.2 0 5.5 3.6 5.5 8s-2.3 8-5.5 8-5.5-3.6-5.5-8S8.8 4 12 4Z', 'fill-rule':'evenodd', fill:'currentColor', stroke:'none' },
      { d: 'M12 5c-2 0-3.5 3.2-3.5 7s1.5 7 3.5 7 3.5-3.2 3.5-7-1.5-7-3.5-7Zm-4-1 2 2M6 7l2 1M5 11l2 1M5.5 15l2 1M7.5 19l2 1M16 4l-2 2M18 7l-2 1M19 11l-2 1M18.5 15l-2 1M16.5 19l-2 1', 'stroke-width':'.8' },
    ]));
    return badge;
  }
  function brandTitle(title) {
    const heading = U.node('h3');
    heading.append(U.node('span', title + ' 2'), U.node('span', 'W', 'ps-buy-brand-w'));
    return heading;
  }
  function control(label, action, style, symbol) {
    const button = U.button(label, action, 'secondary'); button.classList.add('ps-buy-control', 'ps-buy-control--' + (style || 'metal'));
    if (symbol) button.prepend(icon(symbol));
    if (style === 'continue') button.classList.add('ps-buy-continue');
    return button;
  }
  function heading(mode, cartCount, actions) {
    const el = U.node('header', null, 'ps-buy-heading ps-buy-heading--' + mode);
    if (mode !== 'catalog') el.appendChild(control('Voltar', actions.back, 'back', 'back'));
    el.appendChild(mode === 'replenishment' ? U.node('h3', 'Repor o que faltou') : brandTitle(mode === 'cart' ? 'Carrinho da' : 'Comprar na'));
    if (mode !== 'cart') {
      const cart = control('Carrinho', actions.cart, 'cart', 'cart');
      if (cartCount) cart.appendChild(U.node('b', cartCount, 'ps-buy-cart-count'));
      el.appendChild(cart);
    }
    return el;
  }
  function intro(title, subtitle, kind) {
    const el = U.node('div', null, 'ps-buy-intro');
    el.appendChild(kind === 'tire' ? tireBadge() : icon(kind || 'target'));
    const copy = U.node('div'); copy.appendChild(U.node('h4', title));
    if (subtitle) copy.appendChild(U.node('p', subtitle));
    el.appendChild(copy); return el;
  }
  function screws(el) {
    ['tl', 'tr', 'bl', 'br'].forEach(corner => {
      const screw = U.node('i', null, 'ps-buy-screw ps-buy-screw--' + corner);
      screw.setAttribute('aria-hidden', 'true'); el.appendChild(screw);
    });
  }
  function money(cents) { return C.currency.format(cents / 100); }
  function product(row, options) {
    const cart = options.quantity != null;
    const el = U.node('article', null, 'ps-buy-item' + (cart ? ' ps-buy-item--cart' : ''));
    el.dataset.offer = row.offer_key;
    const image = U.node('img', null, 'ps-buy-tire');
    image.src = row.vehicle_type === 'car' ? '/operacao/catalog-tire-car.png' : '/operacao/assets/partner-replenishment-tire-v1.webp';
    image.alt = ''; image.width = 110; image.height = 142; image.loading = 'lazy'; image.decoding = 'async';
    const copy = U.node('div', null, 'ps-buy-item-copy');
    copy.appendChild(U.node('h4', row.measure));
    copy.appendChild(U.node('p', U.condition(row.tire_condition), 'ps-buy-condition'));
    if (row.brand && row.brand !== 'Sem marca') copy.appendChild(U.node('small', row.brand, 'ps-buy-item-brand'));
    const price = row.price_cents == null ? 'A cotar' : money(row.price_cents * (cart ? options.quantity : 1));
    el.append(image, copy, U.node('strong', price, 'ps-buy-price'));
    if (cart) {
      copy.appendChild(U.node('p', row.price_cents == null ? 'Preço a combinar' : money(row.price_cents) + ' cada', 'ps-buy-unit-price'));
      const quantity = U.node('div', null, 'ps-buy-quantity');
      const minus = control('Diminuir quantidade de ' + row.measure, options.minus, 'step'); minus.textContent = '−';
      const plus = control('Aumentar quantidade de ' + row.measure, options.plus, 'step'); plus.textContent = '+';
      minus.disabled = options.busy; plus.disabled = options.busy || options.quantity >= row.quantity_available;
      quantity.append(minus, U.node('b', options.quantity), plus); copy.appendChild(quantity);
      const remove = control('Remover ' + row.measure + ' do carrinho', options.remove, 'remove', 'trash'); remove.disabled = options.busy;
      el.appendChild(remove);
    } else {
      const availability = U.node('div', null, 'ps-buy-availability');
      if (options.demand) {
        const demand = U.node('p', null, 'ps-buy-demand');
        demand.append(icon('target'), U.node('b', options.demand + (options.demand === 1 ? ' cliente pediu' : ' clientes pediram')));
        availability.appendChild(demand);
      }
      const available = U.node('p');
      available.append(U.node('b', row.quantity_available), U.node('span', ' disponíveis' + (options.demand ? ' no galpão' : '')));
      availability.appendChild(available); copy.appendChild(availability);
      const add = control('ADICIONAR', options.add, 'primary', 'cart'); add.disabled = options.busy || row.quantity_available <= options.inCart;
      el.appendChild(add);
    }
    screws(el); return el;
  }
  C.partnerBuyUI = { control, heading, intro, product, money };
}());
