(function () {
  'use strict';
  const C = window.Caixa, el = id => document.getElementById('matrix-fitments' + (id ? '-' + id : ''));
  const dialog = el(''), form = el('form');
  const state = { row: null, vehicle: null, action: 'add', busy: false, version: 0, search: 0 };
  const node = (tag, text) => { const n = document.createElement(tag); n.textContent = text; return n; };
  const position = value => C.operationCatalogUtils.positionLabel(value);
  const years = row => row.year_start || row.year_end
    ? (row.year_start || 'início não informado') + ' – ' + (row.year_end || 'fim não informado') : 'Anos não informados';
  const canEdit = () => C.matrixCatalog.allowed() && state.row?.product_id && state.row?.vehicle_type;
  function reset() {
    state.vehicle = null; state.action = 'add'; state.search++;
    form.reset(); el('position').disabled = false; el('results').replaceChildren();
    el('selected').textContent = ''; el('action').textContent = 'Vincular veículo';
    el('save').textContent = 'Salvar vínculo';
  }
  function busy(on) {
    state.busy = on; dialog.querySelectorAll('button').forEach(b => { b.disabled = on; });
  }
  function select(vehicle, action, fitment) {
    reset(); state.vehicle = { ...vehicle, id: vehicle.id || vehicle.vehicle_model_id }; state.action = action;
    el('selected').textContent = [vehicle.make, vehicle.model, vehicle.variant].filter(Boolean).join(' ');
    el('search').value = el('selected').textContent;
    el('start').value = vehicle.year_start || ''; el('end').value = vehicle.year_end || '';
    if (fitment) {
      el('position').value = fitment.position; el('position').disabled = true;
      el('oem').checked = fitment.is_oem; el('source').value = fitment.source === 'manufacturer' ? 'manufacturer' : 'manual';
    }
    el('action').textContent = action === 'remove' ? 'Remover vínculo selecionado' : action === 'edit' ? 'Ajustar vínculo' : 'Vincular veículo';
    el('save').textContent = action === 'remove' ? 'Confirmar remoção' : 'Salvar vínculo';
    el('selected').scrollIntoView({ block: 'nearest' });
  }
  function render(data) {
    const list = el('list'); list.replaceChildren();
    list.append(node('h3', 'Vínculos do pneu'));
    (data.rows || []).forEach(row => {
      const article = node('article', ''), actions = node('div', '');
      article.append(node('strong', [row.make, row.model, row.variant].filter(Boolean).join(' ')),
        node('p', [position(row.position), years(row), row.is_oem ? 'Original de fábrica' : 'Vínculo cadastrado'].join(' · ')));
      if (canEdit()) {
        for (const [action, label] of [['edit', 'Ajustar'], ['remove', 'Remover']]) {
          const button = node('button', label); button.type = 'button'; button.className = 'matrix-catalog-secondary';
          button.addEventListener('click', () => select(row, action, row)); actions.append(button);
        }
        article.append(actions);
      }
      list.append(article);
    });
    if (!data.rows?.length) list.append(node('p', 'Nenhum vínculo cadastrado para este pneu.'));
    list.append(node('h3', 'Aplicações de referência da medida'),
      node('p', 'Confira modelo, ano e posição. A referência da medida não confirma, por si só, a aplicação deste produto.'));
    (data.applications || []).forEach(row => {
      const article = node('article', '');
      article.append(node('strong', [row.make, row.model].filter(Boolean).join(' ')),
        node('p', [position(row.position), years(row), row.index_spec, row.mounting].filter(Boolean).join(' · ')));
      if (row.notes) article.append(node('p', row.notes));
      if (/^https?:\/\//i.test(row.source_url || '')) {
        const link = node('a', 'Consultar fonte'); link.href = row.source_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; article.append(link);
      }
      list.append(article);
    });
    if (!data.applications?.length) list.append(node('p', 'Sem referência cadastrada para esta medida.'));
    if (data.application_reviews?.length) {
      list.append(node('h3', 'Referências pendentes de conferência'));
      data.application_reviews.forEach(row => list.append(node('p', [row.make, row.model, row.status, row.review_note].filter(Boolean).join(' · '))));
    }
    form.classList.toggle('hidden', !canEdit());
    el('scope').textContent = state.row.vehicle_type === 'motorcycle'
      ? 'Como no web, salvar ou remover um vínculo de moto afeta os pneus cadastrados com a mesma medida e categoria. Confira o veículo e os anos antes de confirmar.'
      : 'O vínculo de carro será alterado somente neste produto. Confira o veículo e os anos antes de confirmar.';
    if (C.matrixCatalog.allowed() && !canEdit()) {
      list.append(node('p', state.row.product_id ? 'Classifique o pneu como Moto ou Carro na ficha técnica para ajustar vínculos.' : 'Complete o cadastro do pneu para ajustar vínculos.'));
    }
  }
  async function load() {
    const version = ++state.version, row = state.row;
    el('message').textContent = 'Carregando compatibilidades…'; el('list').replaceChildren();
    el('retry').classList.add('hidden'); form.classList.add('hidden');
    try {
      const path = row.product_id ? '/' + row.product_id + '/compatibility'
        : '/measure-applications?measure=' + encodeURIComponent(row.tire_size)
          + (row.vehicle_type ? '&vehicle_type=' + encodeURIComponent(row.vehicle_type) : '');
      const data = await C.matrixCatalog.api(path);
      if (version !== state.version || !dialog.open) return;
      render(data); el('message').textContent = '';
    } catch (error) {
      if (version !== state.version || !dialog.open) return;
      el('message').textContent = C.matrixCatalog.message(error); el('retry').classList.remove('hidden');
    }
  }
  async function open(row) {
    if (C.isPartner() || !C.canModule('estoque') || state.busy || !row?.tire_size) return;
    state.row = row; reset(); el('title').textContent = row.tire_size + (row.brand ? ' · ' + row.brand : '');
    if (!dialog.open) dialog.showModal(); await load();
  }
  async function search() {
    if (!canEdit() || state.busy) return;
    const query = el('search').value.trim(), version = state.version, search = ++state.search;
    state.vehicle = null; el('selected').textContent = ''; el('results').replaceChildren();
    if (query.length < 2) { el('message').textContent = 'Digite pelo menos dois caracteres.'; return; }
    el('message').textContent = 'Buscando veículos…';
    try {
      const data = await C.matrixCatalog.api('/vehicle-models?q=' + encodeURIComponent(query) + '&vehicle_type=' + state.row.vehicle_type);
      if (version !== state.version || search !== state.search || !dialog.open) return;
      data.rows.forEach(vehicle => {
        const button = node('button', [vehicle.make, vehicle.model, vehicle.variant, years(vehicle)].filter(Boolean).join(' · '));
        button.type = 'button'; button.className = 'matrix-catalog-secondary';
        button.addEventListener('click', () => select(vehicle, 'add')); el('results').append(button);
      });
      el('message').textContent = data.rows.length ? 'Selecione o veículo correto.' : 'Nenhum veículo encontrado.';
    } catch (error) { if (version === state.version && search === state.search) el('message').textContent = C.matrixCatalog.message(error); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!canEdit() || state.busy || !form.reportValidity()) return;
    if (!state.vehicle) { el('message').textContent = 'Busque e selecione um veículo.'; return; }
    busy(true); state.search++;
    try {
      const path = '/' + state.row.product_id + '/compatibility';
      const reason = el('reason').value.trim(), pos = el('position').value;
      if (state.action === 'remove') {
        await C.matrixCatalog.api(path + '/' + state.vehicle.id + '/' + pos, { reason }, 'DELETE');
      } else {
        await C.matrixCatalog.api(path, { vehicle_model_id: state.vehicle.id, position: pos, reason,
          year_start: el('start').value ? Number(el('start').value) : null,
          year_end: el('end').value ? Number(el('end').value) : null,
          source: el('source').value, is_oem: el('oem').checked, confidence_level: 1 });
      }
      reset(); await load(); await C.loadOperationCatalog(1);
      if (el('retry').classList.contains('hidden')) el('message').textContent = 'Compatibilidade atualizada no app e no web.';
    } catch (error) { el('message').textContent = C.matrixCatalog.message(error); } finally { busy(false); }
  });
  el('search-button').addEventListener('click', search);
  el('search').addEventListener('input', () => { state.vehicle = null; state.search++; state.action = 'add'; el('position').disabled = false; el('selected').textContent = ''; el('results').replaceChildren(); el('action').textContent = 'Vincular veículo'; el('save').textContent = 'Salvar vínculo'; });
  el('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } });
  el('reset').addEventListener('click', reset); el('retry').addEventListener('click', load);
  dialog.querySelector('[data-close-matrix-fitments]').addEventListener('click', () => { if (!state.busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { state.version++; state.search++; });
  C.openMatrixCatalogFitments = open;
}());
