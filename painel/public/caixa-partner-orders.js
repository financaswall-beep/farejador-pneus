(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  function home() {
    const D = C.partnerData;
    if (!D.state.ready || (C.canModule('vendas') && !['ready', 'error'].includes(C.state.photoLoadState))) return U.message('Conferindo pedidos…', 'Aguarde um instante.');
    const photos = C.canModule('vendas') ? C.state.photoRequests || [] : [];
    const pickups = D.pendingPickups();
    const deliveries = D.pendingDeliveries();
    const errors = D.state.errors.length || (C.canModule('vendas') && C.state.photoLoadState === 'error');
    const waiting = Boolean(C.partnerWaiting.current() && C.partnerWaiting.remaining());
    const total = photos.length + pickups.length + deliveries.length + C.partnerWaiting.count();
    const page = U.node('div', null, total || errors ? 'ps-home ps-home--notices' : 'ps-home ps-home--idle');
    if (waiting) {
      page.className = 'ps-home ps-home--notices';
      page.appendChild(U.button('CLIENTE ESPERANDO', () => C.partnerHome.open('partner-waiting'), 'primary', 'clock'));
    }
    const status = U.node('div', null, 'ps-home-status');
    const image = U.node('img'); image.src = '/operacao/assets/partner-status-v2.webp'; image.alt = ''; image.width = 182; image.height = 182;
    const copy = U.node('div');
    copy.appendChild(U.node('h3', waiting ? 'Cliente esperando' : errors && !total ? 'Não consegui atualizar' : total ? 'Sem pedidos novos' : 'Tudo em dia!'));
    copy.appendChild(U.node('p', total ? 'Você tem ' + total + (total === 1 ? ' aviso' : ' avisos') : errors ? 'Tente novamente.' : C.state.photoLoadState === 'idle' && C.canModule('vendas') ? 'Conferindo pedidos de foto…' : 'Nada para responder agora.'));
    status.append(image, copy); page.appendChild(status);
    function notice(kind, count, title, subtitle, label, handler) {
      if (!count) return;
      const row = U.node('section', null, 'ps-notice');
      const info = U.node('div', null, 'ps-notice-info'); info.appendChild(U.icon(kind));
      if (kind !== 'camera') info.appendChild(U.node('b', count, 'ps-notice-count'));
      const text = U.node('div'); text.append(U.node('strong', title), U.node('p', subtitle)); info.appendChild(text);
      row.append(info, U.button(label, handler, 'primary', kind)); page.appendChild(row);
    }
    notice('camera', photos.length, photos.length === 1 ? 'Cliente pediu foto' : photos.length + ' pedidos de foto', photos.length === 1 ? photos[0].tire_size : 'Clientes aguardando', 'ENVIAR FOTO', () => C.partnerHome.open('partner-photos'));
    notice('pickup', pickups.length, pickups.length === 1 ? 'retirada pendente' : 'retiradas pendentes', 'Cliente vem buscar', 'VER PEDIDO', () => C.partnerHome.open('partner-pickups'));
    notice('delivery', deliveries.length, deliveries.length === 1 ? 'entrega pendente' : 'entregas pendentes', deliveries.some(row => row.delivery_status === 'failed') ? 'Há entrega com problema' : '', 'VER ENTREGAS', () => C.partnerHome.open('partner-deliveries'));
    if (errors) {
      page.append(U.node('p', 'Alguns avisos não puderam ser atualizados.', 'ps-copy'), U.button('TENTAR DE NOVO', () => C.partnerHome.refresh(), 'secondary'));
    }
    U.mount(page, 'home');
  }
  C.partnerOrders = { home };
}());
