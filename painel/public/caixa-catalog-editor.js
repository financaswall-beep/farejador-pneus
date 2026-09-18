(function () {
  'use strict';
  const C = window.Caixa, el = id => document.getElementById(id);
  const dialog = el('matrix-catalog-editor'), form = el('matrix-catalog-form');
  const state = { row: null, busy: false, existing: null };
  const create = window.CatalogCreateUtils, measureInput = el('matrix-catalog-measure');
  const measureList = el('matrix-catalog-measure-options');
  let choices = [], choiceIndex = -1;
  const value = name => el('matrix-catalog-' + name).value.trim();
  const nullable = name => value(name) || null;
  const set = (name, value) => { el('matrix-catalog-' + name).value = value == null ? '' : String(value); };
  const allowed = () => !C.isPartner() && C.operationCatalogUtils.isOwner() && C.canModule('estoque');
  const errors = {
    catalog_variant_already_exists: 'Este pneu já está cadastrado. Abra o cadastro existente.',
    catalog_product_code_duplicate: 'Este código já está em uso. Escolha outro código.',
    catalog_measure_invalid: 'Confira a medida. Exemplo: 90/90-18.',
    catalog_brand_required: 'Escolha uma marca para cadastrar o pneu.',
    catalog_product_code_invalid: 'Use letras, números, ponto, hífen, barra ou sublinhado no código.',
    catalog_stock_variant_not_found: 'O item de estoque mudou. Atualize o catálogo e tente novamente.',
    catalog_stock_variant_ambiguous: 'Há mais de um item de estoque para este pneu. Confira o cadastro no web.',
    catalog_stock_vehicle_type_conflict: 'O tipo de veículo conflita com o estoque. Confira a classificação.',
    catalog_compatibility_year_range_invalid: 'O ano final precisa ser igual ou posterior ao ano inicial.',
    catalog_compatibility_vehicle_type_mismatch: 'O veículo e o pneu precisam ser da mesma categoria.',
    owner_required: 'Somente o proprietário pode alterar o catálogo.',
    invalid_session: 'A sessão mudou. Entre novamente para continuar.',
  };
  function message(error) {
    const code = error instanceof Error ? error.message : String(error);
    return errors[code] || (code.includes('vehicle_type') ? 'Confira o tipo de veículo e os vínculos existentes.'
      : 'Não foi possível salvar ou consultar. Confira os campos e tente novamente.');
  }
  async function api(path, body, method) {
    if (C.isPartner()) throw new Error('owner_required');
    const session = C.sessionFingerprint();
    try {
      if (!session) throw new Error('invalid_session');
      const response = await C.authenticatedFetch('/api/caixa/operacao/catalogo' + path, body === undefined ? undefined : {
        method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await C.json(response);
      if (session !== C.sessionFingerprint()) throw new Error('invalid_session');
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      return payload;
    } catch (error) {
      if (error.message === 'invalid_session') {
        dialog.close(); document.getElementById('matrix-fitments').close();
      }
      throw error;
    }
  }
  function busy(value) {
    state.busy = value;
    if (value) closeMeasures();
    dialog.querySelectorAll('button').forEach(button => { button.disabled = value; });
  }
  function closeMeasures() {
    measureList.classList.add('hidden');
    measureInput.setAttribute('aria-expanded', 'false');
    measureInput.removeAttribute('aria-activedescendant');
    choiceIndex = -1;
  }
  function suggestCode() {
    if (state.row?.product_id || state.busy) return;
    if (state.row?.measure_draft && (!value('brand') || !value('condition'))) return;
    set('code', create.productCode(value('measure'), value('brand'), value('condition')));
  }
  function pickMeasure(choice) {
    if (!choice || state.busy) return;
    set('measure', choice.measure); measureInput.setCustomValidity('');
    suggestCode(); closeMeasures();
  }
  function renderMeasures() {
    const catalog = C.operationCatalogState;
    choices = measureInput.disabled || state.busy ? [] : create.measureChoices(value('measure'),
      catalog.rows, catalog.loaded && !catalog.loading && !catalog.error);
    measureList.replaceChildren();
    choices.forEach((choice, index) => {
      const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
      option.id = 'matrix-catalog-measure-option-' + index; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === choiceIndex));
      const title = document.createElement('strong'), note = document.createElement('small');
      title.textContent = choice.isNew ? '+ Usar nova medida ' + choice.measure : choice.measure;
      note.textContent = choice.isNew ? 'Será cadastrada ao salvar o pneu' : 'Já cadastrada';
      option.append(title, note);
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => pickMeasure(choice)); measureList.append(option);
    });
    measureList.classList.toggle('hidden', !choices.length);
    measureInput.setAttribute('aria-expanded', String(Boolean(choices.length)));
    if (choices[choiceIndex]) {
      measureInput.setAttribute('aria-activedescendant', 'matrix-catalog-measure-option-' + choiceIndex);
      measureList.children[choiceIndex].scrollIntoView({ block: 'nearest' });
    } else measureInput.removeAttribute('aria-activedescendant');
  }
  measureInput.addEventListener('input', () => {
    measureInput.setCustomValidity(''); choiceIndex = -1; suggestCode(); renderMeasures();
  });
  measureInput.addEventListener('focus', () => { choiceIndex = -1; renderMeasures(); });
  measureInput.addEventListener('blur', closeMeasures);
  measureInput.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); renderMeasures();
      choiceIndex = event.key === 'ArrowDown' ? Math.min(choiceIndex + 1, choices.length - 1) : Math.max(0, choiceIndex - 1);
      renderMeasures();
    } else if (event.key === 'Enter' && !measureList.classList.contains('hidden')) {
      event.preventDefault(); pickMeasure(choices[choiceIndex]);
    } else if (event.key === 'Escape' && !measureList.classList.contains('hidden')) {
      event.preventDefault(); event.stopPropagation(); closeMeasures();
    }
  });
  ['brand', 'condition'].forEach(name => el('matrix-catalog-' + name).addEventListener('change', suggestCode));
  el('matrix-catalog-code').addEventListener('input', () => set('code', value('code').toUpperCase()));
  function populate(row) {
    state.row = row; state.existing = null;
    form.reset(); el('matrix-catalog-price-form').reset();
    closeMeasures(); measureInput.setCustomValidity('');
    const editing = Boolean(row?.product_id), stock = !editing && row?.creation_mode === 'stock';
    el('matrix-catalog-title').textContent = editing ? 'Configurar pneu' : stock ? 'Completar cadastro' : 'Cadastrar pneu';
    el('matrix-catalog-identity').disabled = editing;
    set('measure', row?.tire_size); set('brand', C.canonicalCatalogBrand(row?.brand));
    set('condition', row ? row.tire_condition : 'meia_vida'); set('code', row?.product_code);
    set('vehicle', row?.vehicle_type); set('position', row?.tire_position);
    set('tread', row?.tread_pattern); set('load', row?.load_index); set('speed', row?.speed_rating);
    set('price', row?.local_sale_price_min);
    // Completar um item mantém a identidade do estoque. O cadastro manual permanece livre.
    ['measure', 'brand', 'condition'].forEach(name => { el('matrix-catalog-' + name).disabled = stock || editing; });
    el('matrix-catalog-spec-reason').required = editing;
    el('matrix-catalog-spec-reason-label').classList.toggle('hidden', !editing);
    el('matrix-catalog-initial-price-label').classList.toggle('hidden', editing);
    el('matrix-catalog-price-form').classList.toggle('hidden', !editing);
    el('matrix-catalog-fitments-open').classList.toggle('hidden', !editing);
    el('matrix-catalog-existing').classList.add('hidden');
    el('matrix-catalog-save').textContent = editing ? 'Salvar ficha técnica' : 'Cadastrar pneu';
    if (!editing && row?.tire_size) suggestCode();
  }
  function open(row) {
    if (!allowed() || state.busy) return;
    populate(row || null); el('matrix-catalog-message').textContent = '';
    if (!dialog.open) dialog.showModal();
    el(row?.product_id ? 'matrix-catalog-vehicle' : row?.creation_mode === 'stock'
      ? 'matrix-catalog-code' : 'matrix-catalog-measure').focus();
  }
  function spec() {
    return { vehicle_type: nullable('vehicle'), position: nullable('position'),
      tread_pattern: nullable('tread'), load_index: nullable('load'), speed_rating: nullable('speed') };
  }
  async function refresh(row) {
    await C.loadOperationCatalog(1);
    const latest = C.operationCatalogState.rows.find(item => item.product_id === row.product_id) || row;
    populate(latest);
    if (C.loadStock) void C.loadStock();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!allowed() || state.busy) return;
    if (!state.row?.product_id) {
      const measure = create.measureValue(value('measure'));
      measureInput.setCustomValidity(measure ? '' : 'Escolha uma medida ou informe uma completa, como 90/90-18 ou 3.00-18.');
    }
    if (!form.reportValidity()) return;
    busy(true); el('matrix-catalog-message').textContent = ''; let created = false;
    const details = spec(), editing = Boolean(state.row?.product_id);
    const measure = value('measure'), brand = value('brand'), condition = value('condition');
    try {
      if (editing) {
        await api('/' + state.row.product_id + '/spec', { ...details, reason: value('spec-reason') });
        await refresh({ ...state.row, ...details, tire_position: details.position });
      } else {
        const mode = state.row?.creation_mode || 'manual';
        const price = value('initial-price') ? Number(value('initial-price')) : null;
        const product = await api('/products', { ...details, measure, brand, tire_condition: condition,
          product_code: value('code'), product_name: 'Pneu ' + brand + ' ' + measure,
          creation_mode: mode, ...(mode === 'manual' ? { price_amount: price } : {}) });
        created = true;
        populate({ ...product, ...details, tire_position: details.position, product_type: 'tire',
          catalogued: true, local_sale_price_min: product.price_amount ?? null });
        if (mode === 'stock' && price !== null) {
          set('price', price); set('price-reason', 'Preço inicial do cadastro');
          await api('/' + product.product_id + '/price', { price_amount: price, reason: 'Preço inicial do cadastro' });
          state.row.local_sale_price_min = price;
        }
        await refresh(state.row);
      }
      el('matrix-catalog-message').textContent = editing ? 'Ficha técnica atualizada no app e no web.'
        : 'Pneu cadastrado. Confira abaixo o preço e as compatibilidades.';
    } catch (error) {
      el('matrix-catalog-message').textContent = created
        ? 'Pneu cadastrado, mas não foi possível concluir a atualização. Confira o preço abaixo antes de vender.' : message(error);
      if (error.message === 'catalog_variant_already_exists') {
        await C.loadOperationCatalog(1);
        state.existing = C.operationCatalogState.rows.find(row => row.product_id
          && String(row.tire_size).replace(/\D/g, '') === measure.replace(/\D/g, '')
          && C.canonicalCatalogBrand(row.brand) === C.canonicalCatalogBrand(brand) && row.tire_condition === condition);
        el('matrix-catalog-existing').classList.toggle('hidden', !state.existing);
      }
    } finally { busy(false); }
  });
  el('matrix-catalog-price-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!allowed() || state.busy || !state.row?.product_id || !event.target.reportValidity()) return;
    busy(true); el('matrix-catalog-message').textContent = '';
    try {
      const price = Number(value('price'));
      await api('/' + state.row.product_id + '/price', { price_amount: price, reason: value('price-reason') });
      await refresh({ ...state.row, local_sale_price_min: price });
      el('matrix-catalog-message').textContent = 'Preço oficial atualizado no app e no web.';
    } catch (error) { el('matrix-catalog-message').textContent = message(error); } finally { busy(false); }
  });
  C.populateCatalogBrandSelect(el('matrix-catalog-brand'));
  el('matrix-catalog-create').addEventListener('click', () => open(null));
  el('matrix-catalog-existing').addEventListener('click', () => open(state.existing));
  el('matrix-catalog-fitments-open').addEventListener('click', () => C.openMatrixCatalogFitments(state.row));
  dialog.querySelector('[data-close-matrix-editor]').addEventListener('click', () => { if (!state.busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
  function appendAction(actions, row) {
    if (!allowed() || row.product_type !== 'tire') return;
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'operation-catalog-price-open'; button.textContent = row.product_id ? 'Configurar pneu' : 'Completar cadastro';
    button.addEventListener('click', () => open(row)); actions.append(button);
  }
  C.matrixCatalog = { api, message, allowed, appendAction };
  C.openMatrixCatalogEditor = open;
}());
