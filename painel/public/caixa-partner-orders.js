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
    const opportunity = C.canModule('estoque') ? D.state.replenishment : null;
    const hasOpportunity = Boolean(opportunity?.measure && opportunity.demand_count > 0 && opportunity.quantity_available > 0);
    const total = photos.length + pickups.length + deliveries.length + C.partnerWaiting.count();
    const idle = !total && !errors && !hasOpportunity && !waiting;
    const page = U.node('div', null, idle ? 'ps-home ps-home--idle' : 'ps-home ps-home--notices');
    if (waiting) {
      page.className = 'ps-home ps-home--notices';
      page.appendChild(U.button('CLIENTE ESPERANDO', () => C.partnerHome.open('partner-waiting'), 'primary', 'clock'));
    }
    const status = U.node('div', null, 'ps-home-status');
    const inlineIcon = (total || hasOpportunity) && !waiting;
    const image = inlineIcon ? U.node('span', null, 'ps-home-ok') : U.node('img');
    if (!inlineIcon) {
      image.src = idle ? '/operacao/assets/partner-idle-emblem-v1.webp' : '/operacao/assets/partner-status-v2.webp';
      image.alt = ''; image.width = idle ? 222 : 182; image.height = image.width; image.decoding = 'async';
    } else { image.setAttribute('aria-hidden', 'true'); image.appendChild(U.icon('check')); }
    const copy = U.node('div');
    copy.appendChild(U.node('h3', waiting ? 'Cliente esperando' : errors && !total ? 'Não consegui atualizar' : total || hasOpportunity ? 'Sem pedidos novos' : 'Tudo em dia!'));
    copy.appendChild(U.node('p', total ? 'Você tem ' + total + (total === 1 ? ' aviso' : ' avisos') : errors ? 'Tente novamente.' : C.state.photoLoadState === 'idle' && C.canModule('vendas') ? 'Conferindo pedidos de foto…' : 'Nada para responder agora.'));
    status.append(image, copy); page.appendChild(status);
    if (photos.length || pickups.length || deliveries.length) page.appendChild(U.node('h4', 'HOJE NA SUA LOJA', 'ps-notices-heading'));
    function notice(kind, count, title, subtitle, label, handler) {
      if (!count) return;
      const row = U.node('button', null, 'ps-notice-card'); row.type = 'button';
      row.setAttribute('aria-label', label); row.addEventListener('click', handler);
      row.append(U.icon(kind), U.node('b', count, 'ps-card-count'));
      const text = U.node('span', null, 'ps-card-copy');
      text.appendChild(U.node('strong', title));
      const meta = U.node('span', null, 'ps-card-meta'); meta.appendChild(U.node('span', subtitle));
      if (kind === 'camera' && photoDeadline !== null) {
        const timer = U.node('span', null, 'ps-photo-countdown'); timer.setAttribute('role', 'timer');
        timer.title = count > 1 ? 'Menor prazo entre os pedidos de foto' : 'Tempo restante para enviar a foto';
        const clock = U.icon('clock'); clock.setAttribute('aria-hidden', 'true');
        const digits = U.node('b'); timer.append(clock, digits); meta.appendChild(timer);
        tickPhoto = () => {
          const seconds = Math.max(0, Math.ceil((photoDeadline - Date.now()) / 1000));
          const value = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
          digits.textContent = value;
          timer.setAttribute('aria-label', seconds ? 'Tempo restante para enviar a foto: ' + value : 'Prazo da foto encerrado');
          if (!seconds) stop();
          return seconds > 0;
        };
      }
      text.appendChild(meta);
      const arrow = U.icon('back'); arrow.classList.add('ps-card-chevron');
      row.append(text, arrow); page.appendChild(row);
    }
    notice('camera', photos.length, photos.length === 1 ? 'Cliente pediu foto' : 'Pedidos de foto', photos.length === 1 ? photos[0].tire_size : 'Clientes aguardando', 'ENVIAR FOTO', () => C.partnerHome.open('partner-photos'));
    notice('pickup', pickups.length, pickups.length === 1 ? 'Retirada pendente' : 'Retiradas pendentes', 'Cliente vem buscar', 'VER PEDIDO', () => C.partnerHome.open('partner-pickups'));
    notice('delivery', deliveries.length, deliveries.length === 1 ? 'Entrega pendente' : 'Entregas pendentes', deliveries.some(row => row.delivery_status === 'failed') ? 'Há entrega com problema' : 'Ver pedidos para entregar', 'VER ENTREGAS', () => C.partnerHome.open('partner-deliveries'));
    if (hasOpportunity) {
      const card = U.node('section', null, 'ps-replenishment');
      const tire = U.node('img'); tire.src = '/operacao/catalog-tire.webp'; tire.alt = 'Pneu ilustrativo'; tire.width = 120; tire.height = 205;
      const visual = U.node('div', null, 'ps-replenishment-visual'); visual.appendChild(tire);
      const content = U.node('div', null, 'ps-replenishment-copy');
      content.append(U.node('small', 'OPORTUNIDADE DE REPOSIÇÃO'), U.node('strong', 'Te pediram'),
        U.node('b', opportunity.measure, 'ps-replenishment-size'),
        U.node('p', opportunity.demand_count + (opportunity.demand_count === 1 ? ' cliente nos últimos 7 dias.' : ' clientes nos últimos 7 dias.')));
      const buy = U.node('button', 'VER NA 2W', 'ps-replenishment-buy'); buy.type = 'button';
      buy.addEventListener('click', () => C.partnerHome.open('partner-replenishment'));
      content.appendChild(buy);
      card.append(visual, content); page.appendChild(card);
    }
    if (errors) {
      page.append(U.node('p', 'Alguns avisos não puderam ser atualizados.', 'ps-copy'), U.button('TENTAR DE NOVO', () => C.partnerHome.refresh(), 'secondary'));
    }
    U.mount(page, 'home');
    if (tickPhoto && tickPhoto()) photoInterval = window.setInterval(tickPhoto, 1000);
  }
  C.partnerOrders = { home, stop };
}());
