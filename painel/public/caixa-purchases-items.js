(function () {
  'use strict';
  const C = window.Caixa, P = C.purchases, s = P.state;
  const normalize = function (value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase(); };
  function updateItem(item, input, key) {
    item[key] = input.value === '' ? '' : Number(input.value);
    P.changed(); P.totals();
  }
  P.renderItems = function () {
    const host = P.id('items'); host.replaceChildren();
    s.draft.items.forEach(function (item, index) {
      const card = P.el('article', 'pc-card'); const top = P.el('div', 'pc-item-top');
      const text = P.el('div'); text.append(P.el('h3', '', item.measure), P.el('p', '', item.brand));
      const badges = P.el('div', 'pc-badges');
      badges.append(P.badge(item.vehicle_type === 'car' ? 'Carro' : item.vehicle_type === 'motorcycle' ? 'Moto' : 'Tipo não definido', 'green'), P.badge(P.condition(item.tire_condition), 'gray'));
      text.append(badges);
      const remove = P.button('', function () { s.draft.items.splice(index, 1); P.changed(); P.renderItems(); P.totals(); }, 'pc-button');
      remove.append(P.icon('trash')); remove.setAttribute('aria-label', 'Remover ' + item.measure);
      top.append(P.tire(item), text, remove);
      const fields = P.el('div', 'pc-grid');
      const quantityLabel = P.el('label', '', 'Quantidade'); const stepper = P.el('span', 'pc-stepper');
      const quantity = P.el('input'); quantity.type = 'number'; quantity.inputMode = 'numeric'; quantity.min = '1'; quantity.max = '100000'; quantity.step = '1'; quantity.required = true; quantity.value = item.quantity;
      quantity.setAttribute('aria-label', 'Quantidade de ' + item.measure);
      quantity.addEventListener('input', function () { updateItem(item, quantity, 'quantity'); subtotal.textContent = P.money(Number(item.quantity) * Number(item.unit_cost)); });
      function step(amount) { quantity.value = Math.max(1, Math.min(100000, Number(quantity.value || 1) + amount)); quantity.dispatchEvent(new Event('input')); }
      const minus = P.button('−', function () { step(-1); }, ''); minus.setAttribute('aria-label', 'Diminuir ' + item.measure);
      const plus = P.button('+', function () { step(1); }, ''); plus.setAttribute('aria-label', 'Aumentar ' + item.measure);
      stepper.append(minus, quantity, plus); quantityLabel.append(stepper);
      const costLabel = P.el('label', '', 'Custo unitário (R$)');
      const cost = P.el('input'); cost.type = 'number'; cost.inputMode = 'decimal'; cost.min = '0'; cost.max = '9999999.99'; cost.step = '0.01'; cost.required = true; cost.placeholder = '0,00'; cost.value = item.unit_cost;
      cost.setAttribute('aria-label', 'Custo unitário de ' + item.measure);
      cost.addEventListener('input', function () { updateItem(item, cost, 'unit_cost'); subtotal.textContent = P.money(Number(item.quantity) * Number(item.unit_cost)); });
      costLabel.append(cost); fields.append(quantityLabel, costLabel);
      const bottom = P.el('div', 'pc-between pc-subtotal'); const subtotal = P.el('strong', '', P.money(Number(item.quantity) * Number(item.unit_cost)));
      bottom.append(P.el('span', '', 'Subtotal'), subtotal); card.append(top, fields, bottom); host.append(card);
    });
    if (!s.draft.items.length) host.append(P.el('p', 'pc-empty', 'Busque uma medida acima para adicionar o primeiro pneu.'));
  };
  P.loadPurchaseCatalog = async function () {
    const session = C.sessionFingerprint();
    P.id('catalog-results').replaceChildren(P.el('p', 'pc-muted', 'Carregando catálogo…'));
    const loaded = await C.loadOperationCatalog(1);
    if (session !== C.sessionFingerprint() || !s.draft) return;
    if (!loaded) {
      P.id('catalog-results').replaceChildren(P.el('p', 'pc-muted', 'Catálogo indisponível.'), P.button('Tentar novamente', P.loadPurchaseCatalog));
    } else P.searchCatalog();
  };
  P.searchCatalog = function () {
    const host = P.id('catalog-results'); host.replaceChildren();
    const search = normalize(P.id('catalog-search').value);
    if (!search || !s.draft) return;
    const rows = C.operationCatalogState.rows.filter(function (row) {
      return row.product_type === 'tire' && normalize([row.tire_size, row.brand, row.product_name].join(' ')).includes(search);
    });
    rows.slice(0, 15).forEach(function (row) {
      const valid = !!row.brand && !!row.tire_condition && row.catalogued !== false;
      const button = P.button('', function () {
        if (!valid) { C.openMatrixCatalogEditor(row); return; }
        const item = { vehicle_type: row.vehicle_type || null, measure: row.tire_size, brand: row.brand,
          tire_condition: row.tire_condition, quantity: 1, unit_cost: '' };
        const existing = s.draft.items.find(function (i) { return i.vehicle_type === item.vehicle_type && i.measure === item.measure && i.brand === item.brand && i.tire_condition === item.tire_condition; });
        if (existing) existing.quantity = Math.min(100000, Number(existing.quantity || 0) + 1);
        else if (s.draft.items.length < 50) s.draft.items.push(item);
        else { P.formError('Adicione até 50 itens por compra.'); return; }
        P.id('catalog-search').value = ''; host.replaceChildren(); P.changed(); P.renderItems(); P.totals();
      }, 'pc-catalog-option');
      const text = P.el('span'); text.append(P.el('strong', '', row.tire_size), P.el('small', '', [row.brand || 'Sem marca', P.condition(row.tire_condition), valid ? 'Adicionar' : 'Completar cadastro'].filter(Boolean).join(' · ')));
      button.append(P.tire(row), text); host.append(button);
    });
    if (!rows.length) host.append(P.el('p', 'pc-empty', 'Nenhum pneu encontrado. Você pode cadastrá-lo abaixo.'));
    if (rows.length > 15) host.append(P.el('p', 'pc-muted', 'Refine a medida ou a marca para ver mais resultados.'));
  };
  P.id('catalog-search').addEventListener('input', P.searchCatalog);
  P.id('catalog-create').addEventListener('click', function () { C.openMatrixCatalogEditor(); });
  document.getElementById('matrix-catalog-editor').addEventListener('close', function () {
    if (s.draft && !P.id('wizard').hidden) void P.loadPurchaseCatalog();
  });
  P.id('add-item').addEventListener('click', function () { P.id('catalog-search').focus(); P.id('catalog-search').scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  ['items', 'lot'].forEach(function (mode) {
    P.id('mode-' + mode).addEventListener('click', function () {
      s.draft.mode = mode; P.changed(); P.renderStep();
    });
  });
}());
