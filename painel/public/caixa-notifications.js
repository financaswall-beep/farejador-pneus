(function () {
  'use strict';

  const Caixa = window.Caixa;
  const state = Caixa.state;
  const badge = document.getElementById('notifications-badge');
  const photoCount = document.getElementById('notifications-photo-count');
  const systemCount = document.getElementById('notifications-system-count');
  const photoView = document.getElementById('notifications-photo-view');
  const systemView = document.getElementById('notifications-system-view');
  const photoContent = document.getElementById('notifications-photo-content');
  const systemContent = document.getElementById('notifications-system-content');
  const tabs = Array.from(document.querySelectorAll('[data-notification-tab]'));

  Object.assign(state, {
    notificationTab: 'photo', systemNotifications: [], systemNotificationPoll: 0,
    systemNotificationError: false, hiddenResolvedPhotos: new Set(),
  });

  function systemPath() {
    return Caixa.isPartner()
      ? Caixa.operationPath('operacao/notificacoes')
      : '/api/caixa/notificacoes';
  }

  function icon(kind) {
    if (kind === 'stock') return Caixa.createSvg([
      { d: 'm4 7 8-4 8 4-8 4-8-4Z' }, { d: 'M4 7v10l8 4 8-4V7M12 11v10' },
    ]);
    if (kind === 'delivery') return Caixa.createSvg([
      { d: 'M3 7h11v10H3zM14 10h4l3 3v4h-7M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z' },
    ]);
    if (kind === 'finance') return Caixa.createSvg([
      { d: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21V3Z' },
      { d: 'M15 8.5c-.7-.7-1.7-1-3-1-1.7 0-3 1-3 2.4 0 3.6 6 1.8 6 5.2 0 1.4-1.3 2.4-3 2.4' },
    ]);
    return Caixa.createSvg([{ d: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4' }]);
  }

  function chevron() {
    return Caixa.createSvg([{ d: 'm9 18 6-6-6-6' }], 'notification-chevron');
  }

  function emptyState(title, copy) {
    const empty = document.createElement('div'); empty.className = 'notifications-empty';
    const mark = document.createElement('span'); mark.textContent = '✓';
    const heading = document.createElement('strong'); heading.textContent = title;
    const paragraph = document.createElement('p'); paragraph.textContent = copy;
    empty.append(mark, heading, paragraph); return empty;
  }

  function photoMeta(item) {
    const age = Math.max(1, Math.floor((Date.now() - new Date(item.created_at).getTime()) / 60000));
    return 'há ' + age + (age === 1 ? ' min' : ' min');
  }

  function photoHero(item) {
    const card = document.createElement('article'); card.className = 'notification-photo-hero';
    const now = document.createElement('b'); now.className = 'notification-now'; now.textContent = 'AGORA';
    const camera = document.createElement('span'); camera.className = 'notification-photo-camera';
    camera.appendChild(Caixa.createSvg([
      { d: 'M14.5 5 16 8h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h3l1.5-3h5Z' },
      { d: 'M12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z' },
    ]));
    const title = document.createElement('h4'); title.textContent = 'Cliente aguardando foto';
    const product = document.createElement('strong'); product.textContent = [item.brand, item.tire_size].filter(Boolean).join(' ') || item.tire_size;
    const meta = document.createElement('p');
    meta.textContent = [item.customer_name, photoMeta(item)].filter(Boolean).join(' • ');
    const image = document.createElement('img'); image.src = '/operacao/catalog-tire.webp'; image.alt = '';
    const action = document.createElement('button'); action.type = 'button';
    action.appendChild(camera.cloneNode(true));
    const actionText = document.createElement('span'); actionText.textContent = 'ENVIAR FOTO AGORA';
    action.appendChild(actionText);
    action.addEventListener('click', function () { Caixa.openPhotoRequest(item.id); });
    card.append(now, camera, title, product, meta, image, action); return card;
  }

  function photoRow(item, resolved) {
    const row = document.createElement('button'); row.type = 'button';
    row.className = resolved ? 'notification-row notification-row--resolved' : 'notification-row';
    const visual = document.createElement('span'); visual.className = 'notification-row-icon';
    visual.appendChild(resolved ? document.createTextNode('✓') : Caixa.createSvg([
      { d: 'M14.5 5 16 8h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h3l1.5-3h5Z' },
      { d: 'M12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z' },
    ]));
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = resolved ? 'Foto enviada' : ([item.brand, item.tire_size].filter(Boolean).join(' ') || 'Pedido de foto');
    const meta = document.createElement('small');
    meta.textContent = resolved ? [item.tire_size, item.customer_name].filter(Boolean).join(' • ') : photoMeta(item);
    copy.append(title, meta);
    const tag = document.createElement('b'); tag.textContent = resolved ? 'Resolvido' : 'Novo';
    row.append(visual, copy, tag, chevron());
    row.addEventListener('click', function () { if (!resolved) Caixa.openPhotoRequest(item.id); });
    return row;
  }

  function renderPhotos() {
    photoContent.replaceChildren();
    const pending = state.photoRequests || [];
    const resolved = (state.photoResolved || []).filter(function (item) {
      return !state.hiddenResolvedPhotos.has(item.id);
    });
    if (!pending.length && !resolved.length) {
      photoContent.appendChild(emptyState('Nenhum pedido de foto', 'Quando um cliente solicitar uma imagem, ela aparecerá aqui.'));
      return;
    }
    if (pending[0]) photoContent.appendChild(photoHero(pending[0]));
    if (pending.length > 1) {
      const title = document.createElement('h4'); title.className = 'notifications-section-title';
      title.textContent = 'Outros pedidos de foto'; photoContent.appendChild(title);
      const list = document.createElement('div'); list.className = 'notifications-list';
      pending.slice(1).forEach(function (item) { list.appendChild(photoRow(item, false)); });
      photoContent.appendChild(list);
    }
    if (resolved.length) {
      const title = document.createElement('h4'); title.className = 'notifications-section-title';
      title.textContent = 'Resolvidos hoje'; photoContent.appendChild(title);
      const list = document.createElement('div'); list.className = 'notifications-list';
      resolved.forEach(function (item) { list.appendChild(photoRow(item, true)); });
      photoContent.appendChild(list);
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'notifications-clear';
      clear.textContent = 'LIMPAR AVISOS RESOLVIDOS';
      clear.addEventListener('click', function () {
        resolved.forEach(function (item) { state.hiddenResolvedPhotos.add(item.id); }); renderPhotos();
      });
      photoContent.appendChild(clear);
    }
  }

  function openTarget(target) {
    if (target === 'stock') { Caixa.showTab('stock'); void Caixa.loadStock(); return; }
    if (target === 'deliveries') { Caixa.showTab('deliveries'); void Caixa.loadDeliveries(); return; }
    if (target === 'finance') { window.location.hash = '#financeiro'; Caixa.showTab('finance'); void Caixa.loadFinance(); }
  }

  function renderSystem() {
    systemContent.replaceChildren();
    if (state.systemNotificationError) {
      systemContent.appendChild(emptyState('Não foi possível atualizar', 'Tente novamente em alguns instantes.'));
      return;
    }
    if (!state.systemNotifications.length) {
      systemContent.appendChild(emptyState('Tudo certo por aqui', 'Nenhuma ação interna precisa da sua atenção agora.'));
      return;
    }
    const title = document.createElement('h4'); title.className = 'notifications-section-title';
    title.textContent = 'Próximas ações'; systemContent.appendChild(title);
    const list = document.createElement('div'); list.className = 'notifications-list';
    state.systemNotifications.forEach(function (item) {
      const row = document.createElement('button'); row.type = 'button';
      row.className = 'notification-row notification-row--system';
      const visual = document.createElement('span'); visual.className = 'notification-row-icon'; visual.appendChild(icon(item.kind));
      const copy = document.createElement('span');
      const heading = document.createElement('strong'); heading.textContent = item.title;
      const description = document.createElement('small'); description.textContent = item.description;
      copy.append(heading, description);
      const tag = document.createElement('b'); tag.textContent = item.badge || 'Sistema';
      if (item.priority === 'attention') tag.classList.add('attention');
      row.append(visual, copy, tag, chevron());
      row.addEventListener('click', function () { openTarget(item.target); });
      list.appendChild(row);
    });
    systemContent.appendChild(list);
  }

  function renderNotifications() {
    const photos = (state.photoRequests || []).length;
    const systems = state.systemNotifications.length;
    const total = photos + systems;
    photoCount.textContent = String(photos); systemCount.textContent = String(systems);
    badge.textContent = String(total); badge.classList.toggle('hidden', total === 0);
    tabs.forEach(function (tab) {
      const selected = tab.dataset.notificationTab === state.notificationTab;
      tab.classList.toggle('active', selected); tab.setAttribute('aria-pressed', String(selected));
    });
    photoView.classList.toggle('hidden', state.notificationTab !== 'photo');
    systemView.classList.toggle('hidden', state.notificationTab !== 'system');
    renderPhotos(); renderSystem();
  }

  async function loadSystemNotifications() {
    if (!Caixa.token()) return;
    try {
      const response = await Caixa.authenticatedFetch(systemPath());
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      state.systemNotifications = Array.isArray(payload.notifications) ? payload.notifications : [];
      state.systemNotificationError = false;
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_session') return;
      state.systemNotificationError = true;
    }
    renderNotifications();
  }

  function startSystemNotifications() {
    stopSystemNotifications(); void loadSystemNotifications();
    state.systemNotificationPoll = window.setInterval(loadSystemNotifications, 30000);
  }

  function stopSystemNotifications() {
    window.clearInterval(state.systemNotificationPoll); state.systemNotificationPoll = 0;
    state.systemNotifications = []; state.systemNotificationError = false; renderNotifications();
  }

  function openNotifications(tab) {
    state.notificationTab = tab === 'system' ? 'system' : 'photo';
    window.location.hash = '#notificacoes'; Caixa.showTab('notifications'); renderNotifications();
    void loadSystemNotifications();
  }

  Object.assign(Caixa, {
    renderNotifications, loadSystemNotifications, startSystemNotifications,
    stopSystemNotifications, openNotifications,
  });
  document.getElementById('notifications-button').addEventListener('click', function () { openNotifications('photo'); });
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      state.notificationTab = tab.dataset.notificationTab === 'system' ? 'system' : 'photo'; renderNotifications();
    });
  });
  renderNotifications();
}());
