(function () {
  'use strict';
  const C = window.Caixa;
  C.createMatrixDeliveryView = function () {
    const root = document.getElementById('matrix-delivery-flow');
    const byId = id => document.getElementById(id);
    function node(tag, text, cls) {
      const el = document.createElement(tag); if (text != null) el.textContent = text;
      if (cls) el.className = cls; return el;
    }
    function action(label, name, id, primary, disabled) {
      const button = node('button', label, primary ? 'mdf-button mdf-primary' : 'mdf-button mdf-secondary');
      button.type = 'button'; button.dataset.mdfAction = name;
      if (id) button.dataset.orderId = id;
      button.disabled = Boolean(disabled); return button;
    }
    function link(label, href) {
      const el = node('a', label, 'mdf-button mdf-secondary');
      el.href = href; el.target = '_blank'; el.rel = 'noopener'; return el;
    }
    const orderLabel = row => row.order_number || '#' + String(row.order_id).replace(/-/g, '').slice(0, 6).toUpperCase();
    const money = value => C.currency.format(value);
    const validAmount = row => typeof row?.total_amount === 'number' && Number.isFinite(row.total_amount) && row.total_amount >= 0;
    const items = row => (row.items || []).map(item => `${item.quantity} × ${item.label || 'Pneu'}`).join(' · ') || 'Itens a conferir';
    const status = row => ({ pending: 'Aguardando saída', dispatched: 'Em entrega', delivered: 'Entregue', failed: 'Problema informado' })[row.delivery_status];
    const photos = new Map(); let photoSession = '';
    function resetPhotos() {
      photos.forEach(promise => promise.then(url => { if (url) URL.revokeObjectURL(url); }));
      photos.clear(); photoSession = C.sessionFingerprint();
    }
    const people = C.createDeliveryPeople(root);
    function photo(row, item) {
      const box = node('figure', null, 'mdf-photo');
      const fallback = C.tireIllustration(item || {}), image = node('img'); image.hidden = true;
      const caption = node('figcaption', 'Ilustração'); box.append(fallback, image, caption);
      if (row.photo_request_id && row.in_route) {
        const id = row.photo_request_id; const session = C.sessionFingerprint();
        if (!photos.has(id)) {
          const pending = C.authenticatedFetch('/api/caixa/entregas/fotos/' + encodeURIComponent(id))
            .then(response => { if (!response.ok) throw new Error('photo_unavailable'); return response.blob(); })
            .then(blob => {
              const url = URL.createObjectURL(blob);
              if (session !== C.sessionFingerprint() || photoSession !== session) { URL.revokeObjectURL(url); return null; }
              return url;
            }).catch(() => { if (photos.get(id) === pending) photos.delete(id); return null; });
          photos.set(id, pending);
        }
        photos.get(id).then(url => {
          if (url && image.isConnected && session === C.sessionFingerprint()) {
            fallback.hidden = true; image.hidden = false; image.src = url; image.alt = 'Foto do produto deste pedido'; caption.textContent = 'Foto';
            image.onerror = () => { image.hidden = true; fallback.hidden = false; caption.textContent = 'Ilustração'; };
          }
        });
      }
      return box;
    }
    const metal = C.createDeliveryMetalView({ node, action, link, orderLabel, status, validAmount, photo, people });
    byId('mdf-back').replaceChildren(metal.icon('back'));
    root.querySelector('.mdf-refresh').replaceChildren(metal.icon('refresh'));
    function render(model) {
      model = { ...model, busy: model.busy || model.loading };
      if (photoSession !== C.sessionFingerprint()) resetPhotos();
      root.classList.remove('hidden'); byId('deliveries-panel').classList.add('matrix-delivery-active');
      const titles = { prepare: 'Entregas', route: 'Minha rota', detail: 'Entrega', payment: 'Receber', close: 'Fechar rota' };
      byId('mdf-title').textContent = titles[model.view];
      root.querySelectorAll('[data-mdf-view]').forEach(el => { el.hidden = el.dataset.mdfView !== model.view; });
      root.querySelectorAll('button,input').forEach(el => { el.disabled = model.busy; });
      root.querySelector('.mdf-tabs').hidden = !['prepare', 'route'].includes(model.view);
      root.querySelectorAll('.mdf-tabs button').forEach(el => {
        if (el.dataset.mdfAction === model.view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
      });
      byId('mdf-selection-count').textContent = model.selected.size + (model.selected.size === 1 ? ' entrega selecionada' : ' entregas selecionadas');
      byId('mdf-route-reported').hidden = !model.route?.reported;
      byId('mdf-route-reported').textContent = model.route?.reported + (model.route?.reported === 1 ? ' problema informado' : ' problemas informados');
      byId('mdf-route-tab').disabled = model.busy || !model.route;
      byId('mdf-back').hidden = ['prepare', 'route'].includes(model.view);
      byId('mdf-error').textContent = model.error || ''; byId('mdf-notice').textContent = model.notice || '';
      byId('mdf-error').hidden = !model.error; byId('mdf-notice').hidden = !model.notice;
      byId('mdf-loading').hidden = !model.loading;
      const queue = model.rows.filter(row => !row.in_route && row.delivery_status === 'pending');
      const query = model.query.trim().toLocaleLowerCase('pt-BR');
      const found = queue.filter(row => [orderLabel(row), row.customer_name, row.delivery_address, items(row)].join(' ').toLocaleLowerCase('pt-BR').includes(query));
      byId('mdf-queue').replaceChildren(...found.map(row => metal.card(row, model, true)));
      byId('mdf-queue-empty').hidden = found.length > 0 || model.loading;
      byId('mdf-queue-empty').textContent = queue.length ? 'Nenhuma entrega encontrada para esta busca.' : 'Nenhuma entrega para sair.';
      byId('mdf-queue-count').textContent = queue.length;
      byId('matrix-route-open').textContent = model.busy ? 'Aguarde…' : 'Montar rota · ' + model.selected.size;
      byId('matrix-route-open').disabled = model.busy || !model.selected.size || Boolean(model.route);
      byId('mdf-open-hint').hidden = !model.route;
      const routeRows = model.rows.filter(row => row.in_route); const route = model.route;
      byId('matrix-route-number').textContent = route ? route.total + (route.total === 1 ? ' parada' : ' paradas') : 'Nenhuma rota aberta';
      byId('mdf-route-code').textContent = route?.trip_number || '';
      byId('mdf-route-open-badge').hidden = !route;
      byId('matrix-route-progress-label').textContent = route ? `${route.completed} de ${route.total} entregas concluídas` : 'Selecione as entregas em Para sair.';
      byId('mdf-route-list').replaceChildren(...routeRows.map(row => metal.card(row, model, false)));
      byId('mdf-route-empty').hidden = routeRows.length > 0;
      if (model.view === 'detail') byId('mdf-detail').replaceChildren(metal.detail(model.rows.find(row => row.order_id === model.detailOrderId && row.in_route), model));
      const unresolved = route?.unresolved ?? 0;
      byId('mdf-go-close').disabled = model.busy || !route || unresolved > 0;
      byId('mdf-close-hint').textContent = unresolved ? `Resolva ${unresolved === 1 ? 'a entrega pendente' : 'as ' + unresolved + ' entregas pendentes'} para encerrar.` : '';
      byId('mdf-close-summary').textContent = route && !unresolved ? '✓ Todas as paradas resolvidas' : 'Há entregas pendentes';
      byId('mdf-close-reported').textContent = route?.reported ? `${route.reported} ${route.reported === 1 ? 'problema informado' : 'problemas informados'} ao escritório.` : '';
      byId('mdf-close-reported').hidden = !route?.reported;
      byId('mdf-close-reported').parentElement.classList.toggle('mdf-has-occurrences', Boolean(route?.reported));
      byId('matrix-route-close-button').disabled = model.busy || !route || unresolved > 0;
      const current = model.rows.find(row => row.order_id === model.paymentOrderId && row.in_route && row.delivery_status === 'dispatched');
      byId('mdf-payment-order').replaceChildren(current ? metal.identity(current, false) : node('p', 'Entrega indisponível'));
      byId('mdf-payment-total').textContent = validAmount(current) ? money(current.total_amount) : 'Valor a confirmar';
      root.querySelectorAll('[name="mdf-payment"]').forEach(el => { el.checked = el.value === model.paymentMethod; });
      byId('mdf-received').checked = model.received;
      byId('mdf-payment-confirm').disabled = model.busy || !validAmount(current) || !model.paymentMethod || !model.received;
      root.setAttribute('aria-busy', String(model.busy)); people.refresh();
    }
    function showOverlay(modal) { root.inert = true; modal.show(); }
    function closeOverlay() { root.inert = false; }
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || C.isPartner()) return;
      const modal = [byId('mdf-receipt-preview'), byId('delivery-failure-modal')].find(el => el.open);
      if (modal) { event.preventDefault(); modal.dispatchEvent(new Event('cancel', { cancelable: true })); }
    });
    return { root, render, showOverlay, closeOverlay, reset: () => { resetPhotos(); people.reset(); closeOverlay(); },
      focus: () => { byId('deliveries-panel').scrollTop = 0; byId('mdf-title').focus(); }, byId, orderLabel };
  };
}());
