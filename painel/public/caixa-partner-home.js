(function () {
  'use strict';
  const C = window.Caixa;
  const id = name => document.getElementById('partner-home-' + name);
  const panel = id('panel');
  let active = false;
  let tab = 'partner-home';
  let viewportLocked = false;
  function updateViewport() {
    const viewport = window.visualViewport;
    // O zoom continua sob controle do navegador; não encolha o layout durante o gesto.
    if (!viewportLocked || (viewport && viewport.scale !== 1)) return;
    const height = viewport?.height || window.innerHeight;
    if (!Number.isFinite(height) || height <= 0) return;
    document.documentElement.style.setProperty('--partner-ios-height', height + 'px');
    document.documentElement.style.setProperty('--partner-ios-top', Math.max(0, viewport?.offsetTop || 0) + 'px');
  }
  function syncViewport(enabled) {
    const nav = window.navigator;
    const ios = /iPhone|iPad|iPod/.test(nav?.userAgent || '')
      || (nav?.platform === 'MacIntel' && nav.maxTouchPoints > 1);
    const locked = enabled && ios;
    if (locked === viewportLocked) return;
    viewportLocked = locked;
    document.documentElement.classList.toggle('partner-ios-locked', locked);
    const listener = locked ? 'addEventListener' : 'removeEventListener';
    window[listener]('resize', updateViewport);
    window.visualViewport?.[listener]('resize', updateViewport);
    window.visualViewport?.[listener]('scroll', updateViewport);
    if (locked) { window.scrollTo(0, 0); updateViewport(); }
    else {
      document.documentElement.style.removeProperty('--partner-ios-height');
      document.documentElement.style.removeProperty('--partner-ios-top');
    }
  }
  function busy() { return C.partnerPhoto.busy() || C.partnerPickups.busy() || C.partnerDeliveries.busy() || C.partnerWaiting.busy() || C.partnerStock.busy() || C.partnerStore.busy() || C.partnerBuy.busy(); }
  function renderConnection() {
    const online = window.navigator?.onLine !== false;
    id('connection').dataset.state = online ? 'online' : 'offline';
    id('connection').setAttribute('aria-label', online ? 'Dispositivo online' : 'Dispositivo offline');
    id('connection').title = online ? 'Dispositivo online' : 'Dispositivo offline';
  }
  function clearAvatar() {
    id('avatar').removeAttribute('src'); id('avatar').classList.add('hidden');
    id('profile').classList.remove('has-avatar');
  }
  function render() {
    if (!active || !C.isPartner() || !C.token()) return;
    const total = (C.canModule('vendas') ? C.state.photoRequests?.length || 0 : 0)
      + C.partnerData.pendingPickups().length + C.partnerData.pendingDeliveries().length
      + C.partnerWaiting.count();
    id('badge').textContent = String(total);
    id('badge').classList.toggle('hidden', total === 0);
    id('notifications').setAttribute('aria-label', total ? 'Ver avisos: ' + total : 'Ver avisos');
    panel.setAttribute('aria-busy', String(!C.partnerData.state.ready));
    if (tab === 'partner-home') C.partnerOrders.home();
    else if (tab === 'partner-waiting') C.partnerWaiting.render();
    else if (tab === 'partner-photos') C.partnerPhoto.list();
    else if (tab === 'partner-photo') C.partnerPhoto.render();
    else if (tab === 'partner-pickups') C.partnerPickups.list();
    else if (tab === 'partner-pickup') C.partnerPickups.render();
    else if (tab === 'partner-deliveries') C.partnerDeliveries.list();
    else if (tab === 'partner-delivery') C.partnerDeliveries.render();
    else if (tab === 'partner-replenishment') C.partnerReplenishment.render();
    else if (tab === 'partner-buy') C.partnerBuy.render('catalog');
    else if (tab === 'partner-cart') C.partnerBuy.render('cart');
    else if (tab === 'partner-sales') C.partnerSales.render();
    else C.partnerExtras.render(tab);
  }
  function start(data) {
    renderConnection();
    id('store').textContent = data.store_name || data.unit_name || C.stored(C.keys.store) || 'Minha loja';
    id('store').title = id('store').textContent;
    id('profile').setAttribute('aria-label', 'Minha loja — ' + (data.display_name || C.stored(C.keys.name) || 'Operador'));
    clearAvatar();
    if (typeof data.avatar_url === 'string' && /^(https?:\/\/|\/(?!\/))/.test(data.avatar_url)) {
      id('avatar').setAttribute('src', data.avatar_url); id('avatar').classList.remove('hidden');
      id('profile').classList.add('has-avatar');
    }
    ['stock', 'sales', 'buy'].forEach(name => {
      const allowed = C.canModule(name === 'sales' ? 'vendas' : 'estoque');
      id(name).disabled = !allowed;
      id(name).title = allowed ? '' : 'Indisponível para este acesso';
    });
    C.partnerData.start();
  }
  function sync(next) {
    C.partnerOrders.stop();
    C.partnerPhoto.leave();
    C.partnerReplenishment.reset();
    active = C.isPartner() && Boolean(C.token());
    tab = next;
    if (!active || next !== 'partner-sales') C.partnerSales.leave();
    if (next !== 'partner-stock') C.partnerStockForm.reset();
    if (next !== 'partner-profile') C.partnerStore.leave();
    C.elements.app.classList.toggle('is-partner-home', active);
    syncViewport(active);
    panel.classList.toggle('hidden', !active);
    if (!active) return;
    const current = next === 'partner-sales' ? 'sales' : next === 'partner-stock' ? 'stock' : next === 'partner-profile' ? '' : ['partner-buy', 'partner-cart', 'partner-replenishment'].includes(next) ? 'buy' : 'orders';
    ['orders', 'sales', 'stock', 'buy'].forEach(name => {
      if (name === current) id(name).setAttribute('aria-current', 'page');
      else id(name).removeAttribute('aria-current');
    });
    render();
    if (next === 'partner-sales') void C.partnerSales.load();
    else if (next === 'partner-replenishment') void C.partnerReplenishment.refresh();
    else if (['partner-buy', 'partner-cart'].includes(next)) void C.partnerBuy.load();
    else if (next === 'partner-stock' || next === 'partner-profile') void C.partnerExtras.load(next);
  }
  function reset() {
    active = false; tab = 'partner-home';
    syncViewport(false);
    C.partnerOrders.stop();
    C.partnerReplenishment.reset();
    C.partnerSales.leave();
    C.partnerReceipt?.close();
    C.partnerBuy.reset();
    C.partnerData.reset(); C.partnerPhoto.reset(); C.partnerPickups.reset(); C.partnerDeliveries.reset(); C.partnerExtras.reset(); C.partnerWaiting.reset();
    panel.classList.add('hidden'); C.elements.app.classList.remove('is-partner-home');
    id('badge').classList.add('hidden'); id('store').textContent = 'Minha loja';
    id('store').title = ''; clearAvatar();
    id('profile').setAttribute('aria-label', 'Minha loja');
    C.partnerUI.root.replaceChildren();
  }
  const hashes = { 'partner-home': '#pedidos', 'partner-sales': '#vendas', 'partner-stock': '#meus-pneus', 'partner-pickups': '#retiradas', 'partner-deliveries': '#entregas', 'partner-profile': '#minha-loja', 'partner-photos': '#fotos', 'partner-replenishment': '#reposicao', 'partner-buy': '#comprar', 'partner-cart': '#carrinho' };
  function open(next, afterSave) {
    if (!C.isPartner() || !C.token()) return;
    if (busy() && !afterSave && next !== tab) { C.showToast('Aguarde a conclusão.'); return; }
    history.replaceState(null, '', location.pathname + location.search + (hashes[next] || '#pedidos'));
    C.showTab(next);
  }
  async function refresh() {
    await Promise.allSettled([C.partnerData.load(), C.canModule('vendas') ? C.loadPhotoRequests() : Promise.resolve()]);
  }
  id('orders').addEventListener('click', () => open('partner-home'));
  id('sales').addEventListener('click', () => open('partner-sales'));
  id('stock').addEventListener('click', () => open('partner-stock'));
  id('buy').addEventListener('click', () => open('partner-buy'));
  id('profile').addEventListener('click', () => open('partner-profile'));
  id('notifications').addEventListener('click', () => open('partner-home'));
  id('avatar').addEventListener('error', clearAvatar);
  window.addEventListener?.('online', renderConnection);
  window.addEventListener?.('offline', renderConnection);
  document.getElementById('nav-partner-home').addEventListener('click', () => open('partner-home'));
  C.partnerHome = { start, sync, reset, render, open, refresh, currentTab: () => tab };
}());
