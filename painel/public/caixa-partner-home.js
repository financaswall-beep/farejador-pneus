(function () {
  'use strict';
  const C = window.Caixa;
  const id = name => document.getElementById('partner-home-' + name);
  const panel = id('panel');
  let active = false;

  function renderConnection() {
    const online = window.navigator?.onLine !== false;
    id('connection').dataset.state = online ? 'online' : 'offline';
    id('connection').setAttribute('aria-label', online ? 'Dispositivo online' : 'Dispositivo offline');
    id('connection').title = online ? 'Dispositivo online' : 'Dispositivo offline';
  }

  function viewState(state, photosAllowed) {
    if (photosAllowed && state.photoRequests?.length) return 'pending';
    if (state.systemNotificationLoadState === 'error'
      || (photosAllowed && state.photoLoadState === 'error')) return 'error';
    if (state.systemNotificationLoadState !== 'ready'
      || (photosAllowed && state.photoLoadState !== 'ready')) return 'loading';
    return state.systemNotifications?.length ? 'notice' : 'idle';
  }

  function render() {
    if (!active || !C.isPartner() || !C.token()) return;
    const state = C.state;
    const status = viewState(state, C.canModule('vendas'));
    const copy = {
      idle: ['Tudo em dia!', 'Nada para responder agora.'],
      pending: ['Cliente esperando', 'Tem pedido de foto para responder.'],
      notice: ['Você tem avisos', 'Toque no sino para conferir.'],
      loading: ['Conferindo pedidos…', 'Aguarde um instante.'],
      error: ['Não consegui atualizar', 'Confira sua conexão e tente de novo.'],
    }[status];
    panel.dataset.status = status;
    panel.setAttribute('aria-busy', String(status === 'loading'));
    id('title').textContent = copy[0];
    id('copy').textContent = copy[1];
    const total = (state.photoRequests || []).length + (state.systemNotifications || []).length;
    id('badge').textContent = String(total);
    id('badge').classList.toggle('hidden', total === 0);
    id('notifications').setAttribute('aria-label', total
      ? 'Ver avisos: ' + total : 'Ver avisos');
    id('action').classList.toggle('hidden', !['pending', 'error'].includes(status));
    id('action').textContent = status === 'pending' ? 'ENVIAR FOTO' : 'TENTAR DE NOVO';
  }

  function start(data) {
    renderConnection();
    id('store').textContent = data.store_name || data.unit_name || C.stored(C.keys.store) || 'Minha loja';
    const name = data.display_name || C.stored(C.keys.name) || 'Operador';
    id('profile').setAttribute('aria-label', 'Minha loja — ' + name);
    id('stock').disabled = !C.canModule('estoque');
    id('stock').title = C.canModule('estoque') ? '' : 'Estoque indisponível para este acesso';
    id('sales').disabled = !C.canModule('vendas');
    id('sales').title = C.canModule('vendas') ? '' : 'Vendas indisponíveis para este acesso';
  }

  function sync(tab) {
    active = C.isPartner() && tab === 'partner-home';
    C.elements.app.classList.toggle('is-partner-home', active);
    panel.classList.toggle('hidden', !active);
    if (active) render();
  }

  function reset() {
    active = false;
    panel.classList.add('hidden');
    C.elements.app.classList.remove('is-partner-home');
    id('badge').classList.add('hidden');
    id('store').textContent = 'Minha loja';
    id('profile').setAttribute('aria-label', 'Minha loja');
  }

  function open() {
    if (!C.isPartner() || !C.token()) return;
    history.replaceState(null, '', location.pathname + location.search + '#pedidos');
    C.showTab('partner-home');
  }

  id('orders').addEventListener('click', open);
  window.addEventListener?.('online', renderConnection);
  window.addEventListener?.('offline', renderConnection);
  document.getElementById('nav-partner-home').addEventListener('click', open);
  id('sales').addEventListener('click', () => {
    if (C.canModule('vendas')) document.getElementById('nav-sales').click();
  });
  id('stock').addEventListener('click', () => {
    if (C.canModule('estoque')) document.getElementById('nav-stock').click();
  });
  id('profile').addEventListener('click', () => document.getElementById('operator-button').click());
  id('notifications').addEventListener('click', () => C.openNotifications(
    C.state.photoRequests?.length ? 'photo' : 'system',
  ));
  id('action').addEventListener('click', () => {
    if (panel.dataset.status === 'pending') {
      C.openPhotoRequest(C.state.photoRequests[0].id);
      return;
    }
    C.state.photoLoadState = 'idle';
    C.state.systemNotificationLoadState = 'idle';
    render();
    if (C.canModule('vendas')) C.startPhotoNotifications();
    void C.loadSystemNotifications();
  });
  C.partnerHome = { start, sync, reset, render, viewState };
}());
