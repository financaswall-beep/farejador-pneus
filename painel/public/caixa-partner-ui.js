(function () {
  'use strict';
  const C = window.Caixa;
  const root = document.getElementById('partner-home-screen');
  const paths = {
    check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M6 18 18 6',
    camera: 'M9 5h6l2 3h4v12H3V8h4l2-3ZM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    pickup: 'M3 5h18l-1 6H4L3 5ZM5 11v10h14V11M9 21v-7h6v7M8 5v6m8-6v6',
    delivery: 'M2 5h12v12H2ZM14 9h4l4 5v3h-8M7 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm11 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
    clock: 'M12 7v5l4 3', back: 'm14 6-6 6 6 6',
    order: 'M8 3h8v4H8ZM6 5H4v17h16V5h-2M8 11h8M8 16h6',
  };
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }
  function icon(kind) { return C.createSvg([{ d: paths[kind] || paths.order }]); }
  function button(label, handler, kind, symbol) {
    const el = node('button', null, 'ps-button ps-button--' + (kind || 'primary'));
    el.type = 'button';
    el.setAttribute('aria-label', label);
    if (symbol) el.appendChild(icon(symbol));
    el.appendChild(node('span', label));
    el.addEventListener('click', handler);
    return el;
  }
  function section(title, back) {
    const el = node('section', null, 'ps-screen');
    const header = node('header', null, 'ps-screen-heading');
    if (back) {
      const control = button('Voltar', back, 'back', 'back');
      header.appendChild(control);
    }
    header.appendChild(node('h3', title)); el.appendChild(header);
    return el;
  }
  function mount(content, mode) {
    root.dataset.view = mode || '';
    root.replaceChildren(content);
  }
  function condition(value) {
    return ({ meia_vida: 'Meia-vida', novo: 'Novo', remold: 'Remold' })[value] || '';
  }
  function orderLabel(row) {
    return row.order_number || 'Pedido #' + String(row.order_id || row.id || '').slice(0, 8).toUpperCase();
  }
  function items(rows) {
    const list = node('div', null, 'ps-items');
    (rows || []).filter(item => !item.pickup_service_code).forEach(item => {
      const line = node('div', null, 'ps-item');
      line.appendChild(node('strong', item.tire_size || item.label || item.item_name || 'Pneu', 'ps-size'));
      const qty = Number(item.quantity || 0);
      line.appendChild(node('p', [condition(item.tire_condition), qty + (qty === 1 ? ' pneu' : ' pneus')].filter(Boolean).join(' • ')));
      list.appendChild(line);
    });
    return list;
  }
  function info(title, text, kind) {
    const el = node('div', null, 'ps-info');
    if (kind) el.appendChild(icon(kind));
    const copy = node('div'); copy.append(node('strong', title), node('p', text));
    el.appendChild(copy); return el;
  }
  function message(title, text, retry) {
    const el = section(title);
    el.appendChild(node('p', text, 'ps-copy'));
    if (retry) el.appendChild(button('TENTAR DE NOVO', retry));
    mount(el, 'message');
  }
  function payment(value, onChange) {
    const field = node('label', 'Pagamento', 'ps-field');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Forma de pagamento');
    ['', 'Pix', 'Dinheiro', 'Cartão'].forEach(method => {
      const option = node('option', method || 'Escolha como recebeu');
      option.value = method; select.appendChild(option);
    });
    select.value = ({ pix: 'Pix', dinheiro: 'Dinheiro', cash: 'Dinheiro', card: 'Cartão', cartao: 'Cartão' })[String(value || '').toLowerCase()] || (['Pix', 'Dinheiro', 'Cartão'].includes(value) ? value : '');
    onChange(select.value);
    select.addEventListener('change', () => onChange(select.value));
    field.appendChild(select); return field;
  }
  function errorMessage(error) {
    const code = error?.message || '';
    if (code === 'reserva_insuficiente' || code.includes('Reserva insuficiente')) return 'A reserva precisa ser conferida. Nada foi baixado.';
    if (/already_|not_found/.test(code)) return 'Esse pedido já mudou. Atualize a tela.';
    if (error?.status === 403) return 'Seu acesso não permite essa ação.';
    return 'Não consegui concluir. Tente novamente.';
  }
  C.partnerUI = { root, node, icon, button, section, mount, condition, orderLabel, items, info, message, payment, errorMessage };
}());
