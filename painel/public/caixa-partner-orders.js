(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  let photoInterval = 0;
  function stop() { window.clearInterval(photoInterval); photoInterval = 0; }
  function home() {
    stop();
    const D = C.partnerData;
    if (!D.state.ready || (C.canModule('vendas') && !['ready', 'error'].includes(C.state.photoLoadState))) return U.message('Conferindo pedidos…', 'Aguarde um instante.');
    const photos = C.canModule('vendas') ? C.state.photoRequests || [] : [];
    const deadlines = photos.map(photo => Date.parse(photo.expires_at || '')).filter(Number.isFinite);
    const photoDeadline = deadlines.length ? Math.min(...deadlines) : null;
    let tickPhoto = null;
    const pickups = D.pendingPickups();
    const deliveries = D.pendingDeliveries();
    const errors = D.state.errors.length || (C.canModule('vendas') && C.state.photoLoadState === 'error');
    const waiting = Boolean(C.partnerWaiting.current() && C.partnerWaiting.remaining());
    const opportunities = C.canModule('estoque') ? D.opportunities() : [];
    const hasOpportunity = opportunities.length > 0;
    const total = photos.length + pickups.length + deliveries.length + C.partnerWaiting.count();
    const idle = !total && !errors && !hasOpportunity && !waiting;
    const page = U.node('div', null, idle ? 'ps-home ps-home--idle' : 'ps-home ps-home--notices');
    if (waiting) {
      page.className = 'ps-home ps-home--notices';
      page.appendChild(U.button('CLIENTE ESPERANDO', () => C.partnerHome.open('partner-waiting'), 'primary', 'clock'));
    }
    const status = U.node('div', null, 'ps-home-status');
    const image = U.node('img', null, idle ? '' : 'ps-home-ok');
    image.src = idle || !waiting ? '/operacao/assets/partner-idle-emblem-v1.webp' : '/operacao/assets/partner-status-v2.webp';
    image.alt = ''; image.width = idle ? 222 : 54; image.height = image.width; image.decoding = 'async';
    const copy = U.node('div');
    copy.appendChild(U.node('h3', waiting ? 'Cliente esperando' : errors && !total ? 'Não consegui atualizar' : total || hasOpportunity ? 'Sem pedidos novos' : 'Tudo em dia!'));
    copy.appendChild(U.node('p', total ? 'Você tem ' + total + (total === 1 ? ' aviso' : ' avisos') : errors ? 'Tente novamente.' : C.state.photoLoadState === 'idle' && C.canModule('vendas') ? 'Conferindo pedidos de foto…' : 'Nada para responder agora.'));
    status.append(image, copy); page.appendChild(status);
    if (photos.length || pickups.length || deliveries.length) page.appendChild(U.node('h4', 'HOJE NA SUA LOJA', 'ps-notices-heading'));
    function notice(kind, count, title, subtitle, label, handler) {
      if (!count) return;
      const photo = kind === 'camera';
      const row = U.node(photo ? 'section' : 'button', null, 'ps-notice-card' + (photo ? ' ps-notice-card--photo' : ''));
      if (!photo) { row.type = 'button'; row.setAttribute('aria-label', label); row.addEventListener('click', handler); }
      const info = photo ? U.node('div', null, 'ps-photo-info') : row;
      const symbol = U.node('span', null, 'ps-card-symbol'); symbol.appendChild(U.icon(kind + '-solid'));
      info.appendChild(symbol);
      if (!photo) info.appendChild(U.node('b', count, 'ps-card-count'));
      const text = U.node('span', null, 'ps-card-copy');
      text.appendChild(U.node('strong', title));
      const meta = U.node('span', null, 'ps-card-meta'); meta.appendChild(U.node('span', subtitle));
      text.appendChild(meta); info.appendChild(text);
      if (photo && photoDeadline !== null) {
        const timer = U.node('span', null, 'ps-photo-countdown'); timer.setAttribute('role', 'timer');
        timer.title = count > 1 ? 'Menor prazo entre os pedidos de foto' : 'Tempo restante para enviar a foto';
        const clock = U.icon('clock'); clock.setAttribute('aria-hidden', 'true');
        const digits = U.node('b'); timer.append(clock, digits); info.appendChild(timer);
        tickPhoto = () => {
          const seconds = Math.max(0, Math.ceil((photoDeadline - Date.now()) / 1000));
          const value = String(Math.floor(seconds / 60)) + ':' + String(seconds % 60).padStart(2, '0');
          digits.textContent = value;
          timer.setAttribute('aria-label', seconds ? 'Tempo restante para enviar a foto: ' + value : 'Prazo da foto encerrado');
          if (!seconds) stop();
          return seconds > 0;
        };
      }
      if (photo) {
        row.append(info, U.button(label, handler, 'notice', 'camera-solid'));
      } else {
        const arrow = U.icon('back'); arrow.classList.add('ps-card-chevron'); row.appendChild(arrow);
      }
      page.appendChild(row);
    }
    const photoLabel = photos.length === 1 ? (photos[0].order_number || photos[0].tire_size || 'Cliente aguardando') : photos.length + ' clientes aguardando';
    notice('camera', photos.length, photos.length === 1 ? 'Cliente pediu foto' : 'Pedidos de foto', photoLabel, 'ENVIAR FOTO', () => C.partnerHome.open('partner-photos'));
    const day = value => new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const today = rows => rows.length && rows.every(row => row.created_at && day(row.created_at) === day(Date.now()));
    notice('pickup', pickups.length, today(pickups) ? (pickups.length === 1 ? 'Retirada hoje' : 'Retiradas hoje') : (pickups.length === 1 ? 'Retirada pendente' : 'Retiradas pendentes'), 'Cliente vem buscar', 'VER PEDIDO', () => C.partnerHome.open('partner-pickups'));
    notice('delivery', deliveries.length, today(deliveries) ? (deliveries.length === 1 ? 'Entrega hoje' : 'Entregas hoje') : (deliveries.length === 1 ? 'Entrega pendente' : 'Entregas pendentes'), deliveries.some(row => row.delivery_status === 'failed') ? 'Há entrega com problema' : 'Ver pedidos para entregar', 'VER ENTREGAS', () => C.partnerHome.open('partner-deliveries'));
    if (hasOpportunity) {
      const card = U.node('section', null, 'ps-replenishment');
      const tire = U.node('img'); tire.src = '/operacao/assets/partner-replenishment-tire-v1.webp'; tire.alt = 'Pneu ilustrativo'; tire.width = 120; tire.height = 180; tire.decoding = 'async';
      const visual = U.node('div', null, 'ps-replenishment-visual'); visual.appendChild(tire);
      visual.appendChild(U.icon('target'));
      const content = U.node('div', null, 'ps-replenishment-copy');
      content.append(U.node('strong', 'Te pediram e você não tinha'),
        U.node('b', opportunities.length + (opportunities.length === 1 ? ' medida para repor' : ' medidas para repor'), 'ps-replenishment-count'),
        U.node('p', 'Disponíveis no galpão da 2W'));
      const buy = U.button('REPOR PNEUS', () => C.partnerHome.open('partner-replenishment'), 'notice', 'cart');
      buy.classList.add('ps-replenishment-buy');
      const arrow = U.icon('back'); arrow.classList.add('ps-buy-chevron'); buy.appendChild(arrow);
      card.append(visual, content, buy); page.appendChild(card);
    }
    if (errors) {
      page.append(U.node('p', 'Alguns avisos não puderam ser atualizados.', 'ps-copy'), U.button('TENTAR DE NOVO', () => C.partnerHome.refresh(), 'secondary'));
    }
    U.mount(page, 'home');
    if (tickPhoto && tickPhoto()) photoInterval = window.setInterval(tickPhoto, 1000);
  }
  C.partnerOrders = { home, stop };
}());
