(function () {
  'use strict';
  const C = window.Caixa, U = C.partnerUI;
  function screws(el) {
    ['tl', 'tr', 'bl', 'br'].forEach(position => {
      const screw = U.node('i', null, 'ps-photo-screw ps-photo-screw--' + position);
      screw.setAttribute('aria-hidden', 'true'); el.appendChild(screw);
    });
    return el;
  }
  function size(item) {
    const name = String(item.tire_size || 'Pneu');
    return name.match(/\b\d{2,3}\s*\/\s*\d{2,3}\s*[-R]\s*\d{2}\b/i)?.[0].replace(/\s/g, '') || name;
  }
  function subtitle(item) { return [U.condition(item.tire_condition), item.brand].filter(Boolean).join(' • '); }
  function photoIcon(kind) {
    const shapes = {
      back: [{ d: 'M20 12H4m7-7-7 7 7 7', 'stroke-width': 3.3 }],
      camera: [{ d: 'M8 5.5 9.6 3h4.8L16 5.5h3A2.5 2.5 0 0 1 21.5 8v10A2.5 2.5 0 0 1 19 20.5H5A2.5 2.5 0 0 1 2.5 18V8A2.5 2.5 0 0 1 5 5.5h3ZM16.5 12.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z', 'stroke-width': 1.8 }],
      send: [{ d: 'M2 2.5 23 12 2 21.5 6.2 13.3 17 12 6.2 10.7 2 2.5Z', fill: 'currentColor', stroke: 'none' }],
      clock: [{ d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 6v6l4 3', 'stroke-width': 1.8 }],
    };
    return shapes[kind] ? C.createSvg(shapes[kind]) : U.icon(kind);
  }
  function action(label, handler, kind, symbol) {
    const el = U.button(label, handler, kind, symbol === 'camera' ? 'camera-solid' : symbol);
    if (symbol === 'send') el.querySelectorAll('svg')[0].replaceWith(photoIcon('send'));
    return el;
  }
  function heading(title, back) {
    const page = U.section(title, back); page.classList.add('ps-photo');
    if (back) page.querySelectorAll('svg')[0].replaceWith(photoIcon('back'));
    return page;
  }
  function identity(page, items) {
    const row = U.node('div', null, 'ps-photo-identity');
    const order = items[0].order_number;
    row.appendChild(U.node('strong', order ? 'Pedido ' + String(order).replace(/^PED-0*(\d+)$/i, '#$1') : items[0].customer_name || 'Foto solicitada'));
    const timer = U.node('span', null, 'ps-photo-deadline'); timer.setAttribute('role', 'timer');
    if (items.some(item => Number.isFinite(Date.parse(item.expires_at)))) {
      const deadline = U.node('span', null, 'ps-photo-deadline-group');
      const clock = U.node('i', null, 'ps-photo-clock'); clock.setAttribute('aria-hidden', 'true'); clock.appendChild(photoIcon('clock'));
      deadline.append(clock, timer); row.appendChild(deadline);
    }
    page.appendChild(row); return timer;
  }
  function capture(page, item, handlers, replaceIndex) {
    const input = U.node('input'); input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment'; input.hidden = true;
    input.setAttribute('aria-label', 'Foto do pneu ' + size(item));
    input.addEventListener('change', () => {
      const file = input.files?.[0]; input.value = ''; void handlers.take(file, item.id, replaceIndex);
    });
    page.appendChild(input); return () => input.click();
  }
  function frame(page, item, handlers, review) {
    const plate = screws(U.node('article', null, 'ps-photo-frame' + (review ? ' ps-photo-frame--review' : '')));
    if (!item.photos.length) {
      const empty = U.node('div', null, 'ps-photo-empty');
      empty.append(photoIcon(item.sent ? 'check' : 'camera'), U.node('p', item.sent ? 'Foto encaminhada' : 'Tire uma foto nítida do pneu'));
      plate.appendChild(empty);
    }
    item.photos.forEach((photo, i) => {
      const box = U.node('div', null, 'ps-photo-image');
      const img = U.node('img'); img.src = photo.url; img.alt = 'Foto ' + (i + 1) + ' do pneu ' + size(item);
      box.appendChild(img);
      if (!review && !item.sent) {
        const remove = action('Apagar foto ' + (i + 1), () => handlers.remove(item.id, i), 'secondary', 'close');
        remove.classList.add('ps-photo-remove'); box.appendChild(remove);
      }
      plate.appendChild(box);
    });
    if (review) {
      const caption = U.node('div', null, 'ps-photo-caption');
      const copy = U.node('div'); copy.append(U.node('strong', size(item)), U.node('p', subtitle(item)));
      caption.appendChild(copy);
      if (!item.sent && item.photos.length) {
        // Cancelar a câmera conserva a foto anterior.
        item.photos.forEach((_, i) => caption.appendChild(action(item.photos.length > 1 ? 'REFAZER ' + (i + 1) : 'REFAZER', capture(page, item, handlers, i), 'secondary', 'camera')));
      }
      plate.appendChild(caption);
    }
    return plate;
  }
  function list(groups, open) {
    const page = heading('Pedidos de foto', () => C.partnerHome.open('partner-home'));
    if (!groups.length) page.appendChild(U.node('p', 'Nenhuma foto para enviar.', 'ps-photo-helper'));
    groups.forEach(items => {
      const card = screws(U.node('article', null, 'ps-photo-request'));
      card.append(U.node('strong', items[0].customer_name || 'Cliente aguardando foto'), U.node('p', items.map(size).join(' • ')));
      card.appendChild(action(items.length > 1 ? 'FOTOGRAFAR ' + items.length + ' PNEUS' : 'TIRAR FOTO', () => open(items[0].id), 'primary', 'camera'));
      page.appendChild(card);
    });
    U.mount(page, 'photos');
  }
  function render(state, handlers) {
    const { items, index, reviewing, busy, error } = state;
    const item = items[index], multiple = items.length > 1;
    const page = heading(reviewing ? 'Conferir fotos' : 'Foto do pneu', handlers.back);
    const plate = screws(U.node('div', null, 'ps-photo-tire'));
    const timer = identity(plate, items); page.appendChild(plate);
    if (reviewing) {
      plate.classList.add('ps-photo-tire--review');
      page.appendChild(U.node('p', 'Cada foto vai com a medida certa.', 'ps-photo-instruction'));
      items.forEach(row => page.appendChild(frame(page, row, handlers, true)));
      page.appendChild(action(busy ? 'ENVIANDO…' : 'ENVIAR FOTOS', () => void handlers.send(), 'primary', 'send'));
      page.appendChild(U.node('p', 'O cliente recebe as fotos na conversa.', 'ps-photo-helper'));
    } else {
      if (multiple) plate.appendChild(U.node('p', 'PNEU ' + (index + 1) + ' DE ' + items.length, 'ps-photo-progress'));
      plate.append(U.node('strong', size(item)), U.node('p', subtitle(item)));
      page.appendChild(U.node('p', 'Mostre a banda de rodagem e a lateral.', 'ps-photo-instruction'));
      page.appendChild(frame(page, item, handlers, false));
      if (item.note) page.appendChild(U.node('p', item.note, 'ps-photo-helper'));
      if (item.photos.length) {
        if (!item.sent) {
          const actions = U.node('div', null, 'ps-photo-secondary');
          const count = item.photos.length + Number(item.photo_count || 0);
          actions.appendChild(U.node('span', count + ' de 3 fotos', 'ps-photo-count'));
          if (multiple) actions.appendChild(action('REFAZER FOTO', capture(page, item, handlers, 0), 'secondary', 'camera'));
          if (count < 3) actions.appendChild(action('+ OUTRA FOTO', capture(page, item, handlers), 'secondary', 'camera'));
          page.appendChild(actions);
        }
        const label = multiple ? (index < items.length - 1 ? 'PRÓXIMO PNEU' : 'CONFERIR FOTOS') : 'ENVIAR FOTO';
        page.appendChild(action(busy ? 'AGUARDE…' : label, multiple ? handlers.next : () => void handlers.send(), 'primary', label === 'CONFERIR FOTOS' ? 'check' : 'send'));
        page.appendChild(U.node('p', multiple ? (index < items.length - 1 ? 'Agora fotografe o ' + size(items[index + 1]) + '.' : 'Confira a foto antes de enviar.') : 'O cliente recebe a foto na conversa.', 'ps-photo-helper'));
      } else if (Number(item.photo_count || 0) < 3 && !item.sent) {
        page.appendChild(action(busy ? 'PREPARANDO…' : 'TIRAR FOTO', capture(page, item, handlers), 'primary', 'camera'));
        page.appendChild(U.node('p', 'Confira a foto antes de enviar.', 'ps-photo-helper'));
      } else page.appendChild(U.node('p', 'Esta solicitação já recebeu fotos.', 'ps-photo-helper'));
    }
    if (error) { const el = U.node('p', error, 'ps-error'); el.setAttribute('role', 'alert'); page.appendChild(el); }
    page.querySelectorAll('button,input').forEach(el => { el.disabled = busy; });
    U.mount(page, 'photo'); return timer;
  }
  C.partnerPhotoUI = { list, render };
}());
