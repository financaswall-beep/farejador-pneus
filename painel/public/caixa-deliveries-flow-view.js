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
    const money = value => C.currency.format(Number(value));
    const items = row => (row.items || []).map(item => `${item.quantity} × ${item.label || 'Pneu'}`).join(' · ') || 'Confira os itens do pedido';
    const photos = new Map(); let photoSession = '';
    function photo(row) {
      const box = node('figure', null, 'mdf-photo'); const image = node('img');
      image.src = '/operacao/catalog-tire.webp'; image.alt = 'Referência do produto';
      const caption = node('figcaption', 'Referência do produto'); box.append(image, caption);
      if (row.photo_request_id && row.in_route) {
        const id = row.photo_request_id; const session = C.sessionFingerprint();
        if (!photos.has(id)) photos.set(id, C.authenticatedFetch('/api/caixa/entregas/fotos/' + encodeURIComponent(id))
          .then(response => { if (!response.ok) throw new Error('photo_unavailable'); return response.blob(); })
          .then(blob => {
            const url = URL.createObjectURL(blob);
            if (session !== C.sessionFingerprint() || photoSession !== session) { URL.revokeObjectURL(url); return null; }
            return url;
          }).catch(() => { photos.delete(id); return null; }));
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
      const head = node('div', null, 'mdf-card-head');
      head.append(node('strong', 'Pedido ' + orderLabel(row)), node('span', prepare ? 'Para sair'
        : row.delivery_status === 'dispatched' ? 'Em entrega' : row.delivery_status === 'delivered' ? 'Entregue'
          : row.delivery_status === 'failed' ? 'Problema informado' : 'Aguardando saída', 'mdf-status mdf-status--' + row.delivery_status));
      el.append(head, node('h3', row.customer_name || 'Cliente não identificado'), node('p', items(row), 'mdf-items'));
      el.appendChild(photo(row));
      if (row.delivery_address) el.appendChild(node('p', row.delivery_address, 'mdf-address'));
      const validAmount = typeof row.total_amount === 'number' && Number.isFinite(row.total_amount) && row.total_amount >= 0;
      el.appendChild(node('p', !validAmount ? 'Valor a confirmar' : row.total_amount > 0
        ? (row.delivery_status === 'delivered' ? 'Recebido ' : 'Cobrar ') + money(row.total_amount) : 'Sem cobrança', 'mdf-amount'));
      if (prepare) {
        const button = action(selected ? '✓ Levar nesta saída' : 'Selecionar entrega', 'select', row.order_id, false, model.busy || Boolean(model.route));
        button.setAttribute('aria-pressed', String(selected)); el.appendChild(button);
      } else if (row.delivery_status === 'pending') {
        el.append(action('Sair para esta entrega', 'dispatch', row.order_id, true, model.busy), action('Tive um problema', 'fail', row.order_id, false, model.busy));
      } else if (row.delivery_status === 'dispatched') {
        const links = node('div', null, 'mdf-links');
        if (row.delivery_address) links.append(
          link('Abrir mapa', 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(row.delivery_address)),
          link('Waze', 'https://waze.com/ul?q=' + encodeURIComponent(row.delivery_address) + '&navigate=yes'));
        let phone = String(row.customer_phone || '').replace(/\D/g, '');
        if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
        if (phone) links.append(link('Falar com cliente', 'https://wa.me/' + phone), link('Ligar', 'tel:+' + phone));
        el.append(links, action('Já entreguei', 'payment', row.order_id, true, model.busy), action('Tive um problema', 'fail', row.order_id, false, model.busy));
      } else if (row.delivery_status === 'failed') el.appendChild(node('p', 'Ocorrência registrada. O escritório avalia a próxima ação.', 'mdf-hint'));
      return el;
    }
    function render(model) {
      model = { ...model, busy: model.busy || model.loading };
      const session = C.sessionFingerprint();
      if (photoSession !== session) {
        photos.forEach(promise => promise.then(url => { if (url) URL.revokeObjectURL(url); }));
        photos.clear(); photoSession = session;
      }
      root.classList.remove('hidden'); byId('deliveries-panel').classList.add('matrix-delivery-active');
      const views = ['prepare', 'route', 'payment', 'close'];
      const titles = ['O que vai sair?', 'Minha rota', 'Confirmar entrega', 'Finalizar minha rota'];
      const index = views.indexOf(model.view);
      byId('mdf-title').textContent = titles[index]; byId('mdf-step').textContent = 'Etapa ' + (index + 1) + ' de 4';
      root.querySelectorAll('[data-mdf-view]').forEach(el => { el.hidden = el.dataset.mdfView !== model.view; });
      root.querySelectorAll('[data-mdf-step]').forEach(el => {
        el.classList.toggle('is-current', el.dataset.mdfStep === model.view);
        if (el.dataset.mdfStep === model.view) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
      });
      root.querySelectorAll('button,input').forEach(el => { el.disabled = model.busy || model.loading; });
      root.querySelector('.mdf-tabs').hidden = ['payment', 'close'].includes(model.view);
      root.querySelectorAll('.mdf-tabs button').forEach(el => {
        if (el.dataset.mdfAction === model.view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
      });
      byId('mdf-route-tab').disabled = model.busy || !model.route;
      byId('mdf-back').hidden = model.view === 'prepare';
      byId('mdf-error').textContent = model.error || ''; byId('mdf-notice').textContent = model.notice || '';
      byId('mdf-error').hidden = !model.error; byId('mdf-notice').hidden = !model.notice;
      const queue = model.rows.filter(row => !row.in_route && row.delivery_status === 'pending');
      const query = model.query.trim().toLocaleLowerCase('pt-BR');
      const found = queue.filter(row => [orderLabel(row), row.customer_name, row.delivery_address, items(row)].join(' ').toLocaleLowerCase('pt-BR').includes(query));
      byId('mdf-queue').replaceChildren(...found.map(row => card(row, model, true)));
      byId('mdf-queue-empty').hidden = found.length > 0; byId('mdf-queue-count').textContent = queue.length;
      byId('matrix-route-selected').textContent = model.selected.size + (model.selected.size === 1 ? ' entrega selecionada' : ' entregas selecionadas');
      byId('matrix-route-open').disabled = model.busy || !model.selected.size || Boolean(model.route);
      byId('mdf-open-hint').textContent = model.route ? 'Você já tem uma rota aberta. Finalize a rota atual antes de montar outra.' : 'Confira os pedidos antes de sair.';
      const routeRows = model.rows.filter(row => row.in_route); const route = model.route;
      byId('matrix-route-number').textContent = route?.trip_number || 'Nenhuma rota aberta';
      byId('matrix-route-progress-label').textContent = route ? `${route.completed} de ${route.total} entregas concluídas` : 'Selecione os pedidos em Preparar saída.';
      byId('mdf-route-list').replaceChildren(...routeRows.map(row => card(row, model, false)));
      byId('mdf-route-empty').hidden = routeRows.length > 0;
      const unresolved = route?.unresolved ?? 0;
      byId('mdf-go-close').disabled = model.busy || !route || unresolved > 0;
      byId('mdf-close-hint').textContent = unresolved ? `Resolva ${unresolved === 1 ? 'a entrega pendente' : 'as ' + unresolved + ' entregas pendentes'} para encerrar.` : 'Todas as paradas foram resolvidas. Você já pode finalizar a rota.';
      byId('mdf-close-summary').textContent = route ? `${route.completed} ${route.completed === 1 ? 'entrega concluída' : 'entregas concluídas'}` : 'Rota não disponível';
      byId('mdf-close-reported').textContent = route?.reported ? `${route.reported} ${route.reported === 1 ? 'ocorrência informada' : 'ocorrências informadas'} ao escritório.` : 'Nenhuma entrega pendente.';
      byId('mdf-close-reported').parentElement.classList.toggle('mdf-has-occurrences', Boolean(route?.reported));
      byId('matrix-route-close-button').disabled = model.busy || !route || unresolved > 0;
      const current = model.rows.find(row => row.order_id === model.paymentOrderId && row.in_route && row.delivery_status === 'dispatched');
      byId('mdf-payment-order').textContent = current ? 'Pedido ' + orderLabel(current) + ' · ' + (current.customer_name || 'Cliente') : 'Pedido indisponível. Volte à rota e atualize.';
      const validCurrent = current && typeof current.total_amount === 'number' && Number.isFinite(current.total_amount) && current.total_amount >= 0;
      byId('mdf-payment-total').textContent = validCurrent ? money(current.total_amount) : 'Valor a confirmar';
      root.querySelectorAll('[name="mdf-payment"]').forEach(el => { el.checked = el.value === model.paymentMethod; });
      byId('mdf-received').checked = model.received;
      byId('mdf-payment-confirm').disabled = model.busy || !validCurrent || !model.paymentMethod || !model.received;
      root.setAttribute('aria-busy', String(model.busy || model.loading));
    }
    return { root, render, focus: () => byId('mdf-title').focus(), byId, orderLabel };
  };
}());
