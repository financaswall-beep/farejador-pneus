(function () {
  'use strict';
  const C = window.Caixa;
  C.createDeliveryMetalView = function ({ node, action, link, orderLabel, status, validAmount, photo, people }) {
    const icons = {
      back: 'm15 18-6-6 6-6', refresh: 'M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6 6.5L4 9m16 6-2 2.5A7 7 0 0 1 5.5 15',
      truck: 'M1 4h13v13H1V4Zm13 5h4l4 5v3h-8M7 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm13 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
      check: 'm5 12 4 4L19 6', problem: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v.1',
      map: 'm22 2-7 20-4-9-9-4 20-7Z', pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
      box: 'm3 7 9-5 9 5v10l-9 5-9-5V7Zm0 0 9 5 9-5M12 12v10M7 5l10 5', search: 'M20 20l-5-5M17 10A7 7 0 1 1 3 10a7 7 0 0 1 14 0Z',
    };
    function icon(name) { const svg = C.createSvg([{ d: icons[name] || icons.box }]); svg.classList.add('mdf-icon'); return svg; }
    function plate(title, cls) { const el = node('section', null, 'mcg-plate ' + (cls || '')); if (title) el.appendChild(node('h4', title)); return el; }
    function identity(row, showStatus) {
      const el = node('div', null, 'mdf-identity'), copy = node('div');
      copy.append(node('h3', row.customer_name || 'Cliente não identificado'), node('small', orderLabel(row)));
      el.append(people.avatar(row), copy);
      if (showStatus) el.appendChild(node('span', status(row), 'mdf-status mdf-status--' + row.delivery_status));
      return el;
    }
    function products(row, compact) {
      const list = node('div', null, compact ? 'mdf-products mdf-products--compact' : 'mdf-products');
      for (const item of row.items || []) {
        const line = node('div', null, 'mdf-product'), copy = node('div', null, 'mdf-product-copy');
        const size = item.tire_size || String(item.label || 'Pneu').match(/\b\d{2,3}\/\d{2,3}[-R ]\d{2}\b/i)?.[0];
        const condition = ({ novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' })[item.tire_condition];
        const category = ({ car: 'Carro', motorcycle: 'Moto' })[item.vehicle_type];
        const description = [item.brand, condition, category].filter(Boolean).join(' · ');
        copy.append(node('strong', size || item.label || 'Pneu'), node('small', description || item.label || 'Cadastro a conferir'),
          node('p', item.quantity + (Number(item.quantity) === 1 ? ' pneu' : ' pneus')));
        // Uma foto de pedido não representa os demais modelos de uma compra com vários itens.
        line.append(photo(row.items.length === 1 ? row : { ...row, photo_request_id: null }, item), copy); list.appendChild(line);
      }
      if (!list.children.length) list.appendChild(node('p', 'Itens a conferir', 'mdf-hint'));
      return list;
    }
    function charge(row, compact) {
      const el = node('div', null, compact ? 'mdf-charge-line' : 'mdf-payment-value mcg-plate');
      const label = row.delivery_status === 'delivered' ? 'Recebido' : row.delivery_status === 'failed' ? 'Valor do pedido' : 'Cobrar';
      el.append(node('span', compact || row.delivery_status === 'failed' ? label : label + ' na entrega'),
        node('strong', validAmount(row) ? C.currency.format(row.total_amount) : 'Valor a confirmar'));
      return el;
    }
    function card(row, model, prepare) {
      const el = node('article', null, 'mdf-card mcg-plate'); el.dataset.orderId = row.order_id;
      const selected = model.selected.has(row.order_id);
      if (prepare && selected) el.classList.add('is-selected');
      el.appendChild(identity(row, !prepare));
      const content = node('div', null, 'mdf-card-content'), product = node('div');
      product.append(products(row, true), charge(row, true)); content.appendChild(product);
      if (prepare) {
        const button = action('', 'select', row.order_id, false, model.busy);
        button.classList.add('mdf-selection'); button.setAttribute('aria-pressed', String(selected));
        button.setAttribute('aria-label', (selected ? 'Retirar ' : 'Levar ') + (row.customer_name || orderLabel(row)) + ' nesta saída');
        const mark = node('span', null, 'mdf-selection-mark'); mark.setAttribute('aria-hidden', 'true');
        if (selected) mark.appendChild(icon('check'));
        button.append(mark, node('span', 'Levar nesta saída')); content.appendChild(button);
      }
      el.appendChild(content);
      if (!prepare) {
        if (row.delivery_status === 'failed' && row.delivery_failure_reason) el.appendChild(node('p', row.delivery_failure_reason, 'mdf-failure-reason'));
        el.appendChild(action(['pending', 'dispatched'].includes(row.delivery_status) ? 'Continuar entrega' : 'Ver entrega',
          'detail', row.order_id, ['pending', 'dispatched'].includes(row.delivery_status), model.busy));
      }
      return el;
    }
    function detail(row, model) {
      const el = node('article', null, 'mdf-detail');
      if (!row) { el.appendChild(node('p', 'Entrega indisponível. Volte à rota e atualize.', 'mdf-empty')); return el; }
      el.dataset.orderId = row.order_id;
      const head = plate(null, 'mdf-detail-identity'); head.appendChild(identity(row, true)); el.appendChild(head);
      const product = plate('Produto'); product.appendChild(products(row, false)); el.appendChild(product);
      const address = plate('Endereço'); const text = node('div', null, 'mdf-address-line');
      text.append(icon('pin'), node('p', row.delivery_address || 'Endereço não informado', 'mdf-detail-address')); address.appendChild(text);
      if (row.delivery_address && row.delivery_status === 'dispatched') {
        const map = link('Abrir mapa', 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(row.delivery_address));
        map.prepend(icon('map')); address.appendChild(map);
      }
      el.append(address, charge(row, false));
      const actions = node('div', null, 'mdf-detail-actions');
      if (row.delivery_status === 'pending') {
        const start = action('Iniciar entrega', 'dispatch', row.order_id, true, model.busy); start.prepend(icon('truck')); actions.appendChild(start);
      }
      if (row.delivery_status === 'dispatched') {
        const paid = action('Entreguei e recebi', 'payment', row.order_id, true, model.busy || !validAmount(row)); paid.prepend(icon('check')); actions.appendChild(paid);
      }
      if (['pending', 'dispatched'].includes(row.delivery_status)) {
        const problem = action('Problema na entrega', 'fail', row.order_id, false, model.busy); problem.classList.add('mdf-danger');
        problem.prepend(icon('problem')); actions.appendChild(problem);
      }
      if (actions.children.length) el.appendChild(actions);
      if (row.delivery_status === 'failed') {
        el.append(node('p', row.delivery_failure_reason || 'Problema informado', 'mdf-failure-reason'), node('p', 'O escritório avalia a próxima ação.', 'mdf-hint'));
      }
      const contacts = node('details', null, 'mdf-extra'); contacts.appendChild(node('summary', 'Contato e detalhes'));
      const links = node('div', null, 'mdf-links');
      let phone = String(row.customer_phone || '').replace(/\D/g, ''); if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
      if (phone) links.append(link('WhatsApp', 'https://wa.me/' + phone), link('Ligar', 'tel:+' + phone));
      if (row.delivery_address) links.appendChild(link('Waze', 'https://waze.com/ul?q=' + encodeURIComponent(row.delivery_address) + '&navigate=yes'));
      contacts.append(node('p', 'Pedido ' + orderLabel(row)), links); el.appendChild(contacts); return el;
    }
    return { card, detail, identity, icon };
  };
}());
