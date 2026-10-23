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
    function photo(row) {
      const box = node('figure', null, 'mdf-photo'); const image = node('img');
      image.src = '/operacao/catalog-tire.webp'; image.alt = 'Referência do produto';
      const caption = node('figcaption', 'Referência'); box.append(image, caption);
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
            image.src = url; image.alt = 'Foto do produto deste pedido'; caption.textContent = 'Foto do produto';
          }
        });
      }
      return box;
    }
    function card(row, model, prepare) {
      const el = node('article', null, 'mdf-card'); el.dataset.orderId = row.order_id;
      const selected = model.selected.has(row.order_id);
      if (prepare && selected) el.classList.add('is-selected');
      if (!prepare) el.appendChild(node('span', status(row), 'mdf-status mdf-status--' + row.delivery_status));
      el.append(node('h3', row.customer_name || 'Cliente não identificado'), node('p', items(row), 'mdf-items'));
      if (prepare) {
        const button = action('', 'select', row.order_id, false, model.busy || Boolean(model.route));
        button.classList.add('mdf-selection'); button.setAttribute('aria-pressed', String(selected));
        const mark = node('span', selected ? '✓' : '', 'mdf-selection-mark'); mark.setAttribute('aria-hidden', 'true');
        button.append(mark, node('span', 'Levar nesta saída')); el.appendChild(button);
      } else el.appendChild(action('Ver entrega', 'detail', row.order_id, false, model.busy));
      return el;
    }
    function detail(row, model) {
      const el = node('article', null, 'mdf-detail');
      if (!row) { el.appendChild(node('p', 'Entrega indisponível. Volte à rota e atualize.', 'mdf-empty')); return el; }
      el.dataset.orderId = row.order_id;
      const identity = node('div', null, 'mdf-detail-identity');
      identity.append(node('h3', row.customer_name || 'Cliente não identificado'), node('span', status(row), 'mdf-status mdf-status--' + row.delivery_status)); el.appendChild(identity);
      const products = node('section', null, 'mdf-product'); const copy = node('div', null, 'mdf-product-copy');
      for (const item of row.items || []) {
        const label = String(item.label || 'Pneu'); const size = label.match(/\b\d{2,3}\/\d{2,3}[-R ]\d{2}\b/i)?.[0];
        const line = node('div'); line.append(node('strong', size || label), node('p', item.quantity + (Number(item.quantity) === 1 ? ' pneu' : ' pneus')));
        const extra = size ? label.replace(size, '').replace(/\bpneu\b/gi, '').trim() : '';
        if (extra) line.appendChild(node('small', extra)); copy.appendChild(line);
      }
      if (!copy.children.length) copy.appendChild(node('strong', 'Itens a conferir'));
      products.append(photo(row), copy); el.appendChild(products);
      el.appendChild(node('p', row.delivery_address || 'Endereço não informado', 'mdf-detail-address'));
      if (row.delivery_status === 'dispatched' && row.delivery_address) {
        el.appendChild(link('➤ Abrir mapa', 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(row.delivery_address)));
      }
      const charge = node('div', null, 'mdf-payment-value');
      charge.append(node('span', row.delivery_status === 'delivered' ? 'Recebido na entrega' : 'Cobrar na entrega'),
        node('strong', validAmount(row) ? money(row.total_amount) : 'Valor a confirmar')); el.appendChild(charge);
      if (row.delivery_status === 'pending') el.appendChild(action('Iniciar entrega', 'dispatch', row.order_id, true, model.busy));
      if (row.delivery_status === 'dispatched') el.appendChild(action('✓ Entreguei e recebi', 'payment', row.order_id, true, model.busy || !validAmount(row)));
      if (['pending', 'dispatched'].includes(row.delivery_status)) {
        const problem = action('⚠ Problema na entrega', 'fail', row.order_id, false, model.busy); problem.classList.add('mdf-danger'); el.appendChild(problem);
      }
      if (row.delivery_status === 'failed') el.appendChild(node('p', 'O escritório avalia a próxima ação.', 'mdf-hint'));
      const contacts = node('details', null, 'mdf-extra'); contacts.appendChild(node('summary', 'Contato e detalhes'));
      const links = node('div', null, 'mdf-links');
      let phone = String(row.customer_phone || '').replace(/\D/g, ''); if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
      if (phone) links.append(link('WhatsApp', 'https://wa.me/' + phone), link('Ligar', 'tel:+' + phone));
      if (row.delivery_address) links.appendChild(link('Waze', 'https://waze.com/ul?q=' + encodeURIComponent(row.delivery_address) + '&navigate=yes'));
      contacts.append(node('p', 'Pedido ' + orderLabel(row)), links); el.appendChild(contacts); return el;
    }
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
      byId('mdf-route-tab').disabled = model.busy || !model.route;
      byId('mdf-back').hidden = ['prepare', 'route'].includes(model.view);
      byId('mdf-error').textContent = model.error || ''; byId('mdf-notice').textContent = model.notice || '';
      byId('mdf-error').hidden = !model.error; byId('mdf-notice').hidden = !model.notice;
      byId('mdf-loading').hidden = !model.loading;
      const queue = model.rows.filter(row => !row.in_route && row.delivery_status === 'pending');
      const query = model.query.trim().toLocaleLowerCase('pt-BR');
      const found = queue.filter(row => [orderLabel(row), row.customer_name, row.delivery_address, items(row)].join(' ').toLocaleLowerCase('pt-BR').includes(query));
      byId('mdf-queue').replaceChildren(...found.map(row => card(row, model, true)));
      byId('mdf-queue-empty').hidden = found.length > 0 || model.loading;
      byId('mdf-queue-empty').textContent = queue.length ? 'Nenhuma entrega encontrada para esta busca.' : 'Nenhuma entrega para sair.';
      byId('mdf-queue-count').textContent = queue.length;
      byId('matrix-route-open').textContent = model.busy ? 'Aguarde…' : 'Montar rota · ' + model.selected.size;
      byId('matrix-route-open').disabled = model.busy || !model.selected.size || Boolean(model.route);
      byId('mdf-open-hint').hidden = !model.route;
      const routeRows = model.rows.filter(row => row.in_route); const route = model.route;
      byId('matrix-route-number').textContent = route?.trip_number || 'Nenhuma rota aberta';
      byId('matrix-route-progress-label').textContent = route ? `${route.completed} de ${route.total} entregas concluídas` : 'Selecione as entregas em Para sair.';
      byId('mdf-route-list').replaceChildren(...routeRows.map(row => card(row, model, false)));
      byId('mdf-route-empty').hidden = routeRows.length > 0;
      if (model.view === 'detail') byId('mdf-detail').replaceChildren(detail(model.rows.find(row => row.order_id === model.detailOrderId && row.in_route), model));
      const unresolved = route?.unresolved ?? 0;
      byId('mdf-go-close').disabled = model.busy || !route || unresolved > 0;
      byId('mdf-close-hint').textContent = unresolved ? `Resolva ${unresolved === 1 ? 'a entrega pendente' : 'as ' + unresolved + ' entregas pendentes'} para encerrar.` : '';
      byId('mdf-close-summary').textContent = route && !unresolved ? '✓ Todas as paradas resolvidas' : 'Há entregas pendentes';
      byId('mdf-close-reported').textContent = route?.reported ? `${route.reported} ${route.reported === 1 ? 'problema informado' : 'problemas informados'} ao escritório.` : '';
      byId('mdf-close-reported').hidden = !route?.reported;
      byId('mdf-close-reported').parentElement.classList.toggle('mdf-has-occurrences', Boolean(route?.reported));
      byId('matrix-route-close-button').disabled = model.busy || !route || unresolved > 0;
      const current = model.rows.find(row => row.order_id === model.paymentOrderId && row.in_route && row.delivery_status === 'dispatched');
      byId('mdf-payment-order').textContent = current?.customer_name || 'Entrega indisponível';
      byId('mdf-payment-total').textContent = validAmount(current) ? money(current.total_amount) : 'Valor a confirmar';
      root.querySelectorAll('[name="mdf-payment"]').forEach(el => { el.checked = el.value === model.paymentMethod; });
      byId('mdf-received').checked = model.received;
      byId('mdf-payment-confirm').disabled = model.busy || !validAmount(current) || !model.paymentMethod || !model.received;
      root.setAttribute('aria-busy', String(model.busy));
    }
    return { root, render, reset: resetPhotos, focus: () => byId('mdf-title').focus(), byId, orderLabel };
  };
}());
