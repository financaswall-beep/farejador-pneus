(function () {
  'use strict';
  const C = window.Caixa, P = C.purchases, s = P.state;
  const normalize = function (value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase(); };
  function updateItem(item, input, key) {
    item[key] = input.value === '' ? '' : Number(input.value);
    P.changed(); P.totals();
  }
  function identityFields(item, index, refresh) {
    const fields = P.el('div', 'pc-grid pc-identity');
    function field(title, key, options) {
      const label = P.el('label', '', title), input = P.el(options ? 'select' : 'input');
      if (options) options.forEach(function (option) { input.append(new Option(option[1], option[0])); });
      else { input.type = 'text'; input.maxLength = 60; }
      input.required = key !== 'vehicle_type'; input.value = item[key] || '';
      input.setAttribute('aria-label', title + ' do pneu ' + (index + 1));
      input.addEventListener(options ? 'change' : 'input', function () {
        item[key] = key === 'vehicle_type' ? input.value || null : input.value;
        input.setCustomValidity(!options && input.value && !input.value.trim() ? 'Preencha este campo.' : '');
        P.changed(); refresh();
      });
      label.append(input); fields.append(label); return input;
    }
    const measure = field('Medida', 'measure'); measure.placeholder = 'Ex.: 90/90-18'; measure.autocomplete = 'off';
    const options = P.el('div', 'pc-measure-options'); options.id = 'purchase-measures-' + index;
    options.setAttribute('role', 'listbox'); options.setAttribute('aria-label', 'Medidas existentes'); options.hidden = true;
    measure.parentElement.classList.add('pc-measure-field'); measure.parentElement.append(options);
    measure.setAttribute('role', 'combobox'); measure.setAttribute('aria-autocomplete', 'list');
    measure.setAttribute('aria-controls', options.id); measure.setAttribute('aria-expanded', 'false');
    let choices = [], active = -1;
    function close() { options.hidden = true; measure.setAttribute('aria-expanded', 'false'); measure.removeAttribute('aria-activedescendant'); active = -1; }
    function pick(choice) {
      if (!choice || s.pending || s.busy) return;
      measure.value = choice.measure; measure.dispatchEvent(new Event('input')); close(); measure.focus(); close();
    }
    function suggest() {
      choices = window.CatalogCreateUtils.measureChoices(measure.value,
        s.measures.map(function (row) { return { product_type: 'tire', tire_size: row.measure }; }), false);
      options.replaceChildren();
      choices.forEach(function (choice, choiceIndex) {
        const button = P.button(choice.measure, function () { pick(choice); });
        button.id = options.id + '-' + choiceIndex; button.tabIndex = -1; button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(choiceIndex === active));
        button.addEventListener('pointerdown', function (event) { event.preventDefault(); }); options.append(button);
      });
      options.hidden = !choices.length; measure.setAttribute('aria-expanded', String(!!choices.length));
      if (choices[active]) measure.setAttribute('aria-activedescendant', options.children[active].id);
      else measure.removeAttribute('aria-activedescendant');
    }
    measure.addEventListener('input', function () { active = -1; suggest(); });
    measure.addEventListener('focus', function () { active = -1; suggest(); });
    measure.addEventListener('blur', close);
    measure.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); suggest(); active = event.key === 'ArrowDown' ? Math.min(active + 1, choices.length - 1) : Math.max(0, active - 1); suggest();
      } else if (event.key === 'Enter' && !options.hidden) { event.preventDefault(); pick(choices[active] || choices[0]); }
      else if (event.key === 'Escape' && !options.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
    });
    const brand = field('Marca', 'brand'); brand.placeholder = 'Selecione ou digite';
    const brands = P.el('datalist'); brands.id = 'purchase-brands-' + index; brand.setAttribute('list', brands.id);
    [...new Set([...(C.catalogBrandOptions || []), ...s.measures.map(function (row) { return row.brand; }).filter(Boolean)])].sort()
      .forEach(function (name) { brands.append(new Option(name, name)); }); fields.append(brands);
    field('Condição', 'tire_condition', [['', 'Selecione'], ['meia_vida', 'Meia-vida'], ['novo', 'Novo'], ['remold', 'Remold']]);
    field('Tipo de veículo', 'vehicle_type', [['', 'Não identificado'], ['motorcycle', 'Moto'], ['car', 'Carro']]);
    return fields;
  }
  P.renderItems = function () {
    const host = P.id('items'); host.replaceChildren();
    s.draft.items.forEach(function (item, index) {
      const card = P.el('article', 'pc-card'); const top = P.el('div', 'pc-item-top');
      const text = P.el('div'), title = P.el('h3'), brand = P.el('p'); text.append(title, brand);
      const badges = P.el('div', 'pc-badges');
      text.append(badges);
      const remove = P.button('', function () { s.draft.items.splice(index, 1); P.changed(); P.renderItems(); P.totals(); }, 'pc-button');
      remove.append(P.icon('trash')); remove.setAttribute('aria-label', 'Remover ' + item.measure);
      const image = P.tire(item); top.append(image, text, remove);
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
      function refresh() {
        const name = item.measure || 'Pneu ' + (index + 1);
        title.textContent = name; brand.textContent = item.brand || 'Informe a marca';
        badges.replaceChildren(P.badge(item.vehicle_type === 'car' ? 'Carro' : item.vehicle_type === 'motorcycle' ? 'Moto' : 'Não identificado', 'green'));
        if (item.tire_condition) badges.append(P.badge(P.condition(item.tire_condition), 'gray'));
        image.src = item.vehicle_type === 'car' ? '/operacao/catalog-tire-car.png' : '/operacao/catalog-tire.webp';
        quantity.setAttribute('aria-label', 'Quantidade de ' + name); cost.setAttribute('aria-label', 'Custo unitário de ' + name);
        remove.setAttribute('aria-label', 'Remover ' + name);
      }
      bottom.append(P.el('span', '', 'Subtotal'), subtotal); card.append(top, identityFields(item, index, refresh), fields, bottom); host.append(card); refresh();
    });
    if (!s.draft.items.length) host.append(P.el('p', 'pc-empty', 'Busque um pneu acima ou toque em Adicionar pneu por medida.'));
  };
  P.loadPurchaseCatalog = async function () {
    const session = C.sessionFingerprint();
    P.id('catalog-results').replaceChildren(P.el('p', 'pc-muted', 'Carregando catálogo…'));
    const results = await Promise.allSettled([C.loadOperationCatalog(1), P.request('/medidas')]);
    if (session !== C.sessionFingerprint() || !s.draft) return;
    const measures = results[1];
    s.measures = measures.status === 'fulfilled' && Array.isArray(measures.value.rows) ? measures.value.rows : [];
    if (results[0].status !== 'fulfilled' || !results[0].value) {
      P.id('catalog-results').replaceChildren(P.el('p', 'pc-muted', 'Catálogo indisponível.'), P.button('Tentar novamente', P.loadPurchaseCatalog));
    } else P.searchCatalog();
    P.id('measures-note').hidden = measures.status === 'fulfilled' && Array.isArray(measures.value.rows);
  };
  P.searchCatalog = function () {
    const host = P.id('catalog-results'); host.replaceChildren();
    const search = normalize(P.id('catalog-search').value);
    if (!search || !s.draft) return;
    const rows = C.operationCatalogState.rows.filter(function (row) {
      return row.product_type === 'tire' && normalize([row.tire_size, row.brand, row.product_name].join(' ')).includes(search);
    });
    rows.slice(0, 15).forEach(function (row) {
      const button = P.button('', function () {
        if (s.pending || s.busy) return;
        const item = { vehicle_type: row.vehicle_type || null, measure: row.tire_size, brand: row.brand || '',
          tire_condition: row.tire_condition || '', quantity: 1, unit_cost: '' };
        const existing = s.draft.items.find(function (i) { return i.vehicle_type === item.vehicle_type && i.measure === item.measure && i.brand === item.brand && i.tire_condition === item.tire_condition; });
        if (existing) existing.quantity = Math.min(100000, Number(existing.quantity || 0) + 1);
        else if (s.draft.items.length < 50) s.draft.items.push(item);
        else { P.formError('Adicione até 50 itens por compra.'); return; }
        P.id('catalog-search').value = ''; host.replaceChildren(); P.changed(); P.renderItems(); P.totals();
      }, 'pc-catalog-option');
      const text = P.el('span'); text.append(P.el('strong', '', row.tire_size), P.el('small', '', [row.brand || 'Informe a marca', row.tire_condition ? P.condition(row.tire_condition) : 'Informe a condição', 'Adicionar à compra'].join(' · ')));
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
  P.id('add-item').addEventListener('click', function () {
    if (!s.draft || s.pending || s.busy) return;
    if (s.draft.items.length >= 50) { P.formError('Adicione até 50 itens por compra.'); return; }
    s.draft.items.push({ measure: '', brand: '', tire_condition: '', vehicle_type: null, quantity: 1, unit_cost: '' });
    P.changed(); P.renderItems(); P.totals();
    const measure = P.id('items').lastElementChild.querySelector('input'); measure.focus(); measure.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  ['items', 'lot'].forEach(function (mode) {
    P.id('mode-' + mode).addEventListener('click', function () {
      s.draft.mode = mode; P.changed(); P.renderStep();
    });
  });
}());
