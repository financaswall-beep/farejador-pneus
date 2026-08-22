(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const modal = byId('stock-edit-modal');
  const form = byId('stock-edit-form');
  const state = { row: null, idempotencyKey: '' };
  Caixa.populateCatalogBrandSelect(byId('stock-edit-brand'));

  function nullable(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
  }

  function optionalNumber(value) {
    return value === '' ? null : Number(value);
  }

  function setValue(id, value) {
    byId(id).value = value == null ? '' : String(value);
  }

  function close() {
    modal.classList.add('hidden');
    byId('stock-edit-error').textContent = '';
    state.row = null;
  }

  function typeLabel(type) {
    return { pneu: 'Pneu cadastrado', insumo: 'Insumo cadastrado', servico: 'Serviço cadastrado' }[type]
      || 'Produto cadastrado';
  }

  function syncType(row) {
    const tire = row.item_type === 'pneu';
    const service = row.item_type === 'servico';
    document.querySelectorAll('[data-stock-edit-tire]').forEach(function (node) {
      node.classList.toggle('hidden', !tire);
    });
    document.querySelectorAll('[data-stock-edit-product]').forEach(function (node) {
      node.classList.toggle('hidden', service);
    });
    document.querySelectorAll('[data-stock-edit-stock]').forEach(function (node) {
      node.classList.toggle('hidden', service);
    });
    ['stock-edit-width', 'stock-edit-aspect', 'stock-edit-rim'].forEach(function (id) {
      byId(id).required = tire;
    });
    byId('stock-edit-condition').required = tire;
    byId('stock-edit-brand').required = tire;
  }

  function open(row) {
    if (!row || row.update_pending) return;
    state.row = row;
    state.idempotencyKey = Caixa.stockIdempotencyKey('edit');
    form.reset();
    byId('stock-edit-unit').textContent = Caixa.stored(Caixa.keys.store) || 'Unidade parceira';
    byId('stock-edit-type').textContent = typeLabel(row.item_type);
    setValue('stock-edit-name', row.item_name);
    setValue('stock-edit-brand', Caixa.canonicalCatalogBrand(row.brand));
    setValue('stock-edit-width', row.tire_width_mm);
    setValue('stock-edit-aspect', row.tire_aspect_ratio);
    setValue('stock-edit-rim', row.tire_rim_diameter);
    setValue('stock-edit-condition', row.tire_condition || 'novo');
    setValue('stock-edit-position', row.tire_position);
    setValue('stock-edit-minimum', row.minimum_quantity);
    setValue('stock-edit-shelf', row.shelf_location);
    setValue('stock-edit-sku', row.local_sku);
    syncType(row);
    byId('stock-edit-error').textContent = '';
    modal.classList.remove('hidden');
    byId('stock-edit-name').focus({ preventScroll: true });
  }

  function payload() {
    const type = state.row.item_type;
    const result = {
      item_name: byId('stock-edit-name').value.trim(),
      local_sku: nullable(byId('stock-edit-sku').value),
      brand: type === 'servico' ? null : nullable(byId('stock-edit-brand').value),
      idempotency_key: state.idempotencyKey,
    };
    if (type !== 'servico') {
      result.minimum_quantity = optionalNumber(byId('stock-edit-minimum').value);
      result.shelf_location = nullable(byId('stock-edit-shelf').value);
    }
    if (type === 'pneu') {
      result.tire_width_mm = optionalNumber(byId('stock-edit-width').value);
      result.tire_aspect_ratio = optionalNumber(byId('stock-edit-aspect').value);
      result.tire_rim_diameter = optionalNumber(byId('stock-edit-rim').value);
      result.tire_condition = byId('stock-edit-condition').value;
      result.tire_position = nullable(byId('stock-edit-position').value);
    }
    return result;
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!state.row || !form.reportValidity()) return;
    const button = byId('stock-edit-submit');
    const errorNode = byId('stock-edit-error');
    button.disabled = true;
    errorNode.textContent = '';
    try {
      const path = `operacao/estoque/${encodeURIComponent(state.row.stock_id)}/edicoes`;
      const response = await Caixa.authenticatedFetch(Caixa.operationPath(path), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()),
      });
      const result = await Caixa.json(response);
      if (!response.ok) throw new Error(result.error || 'request_failed');
      close();
      Caixa.showToast('Alterações enviadas para aprovação do dono.');
      if (Caixa.refreshStockDetail) void Caixa.refreshStockDetail();
      if (Caixa.loadStock) void Caixa.loadStock();
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      errorNode.textContent = failure instanceof Error && failure.message === 'stock_update_already_pending'
        ? 'Este item já possui uma alteração aguardando aprovação.'
        : 'Não foi possível enviar. Confira os campos e tente novamente.';
    } finally {
      button.disabled = false;
    }
  });

  document.querySelectorAll('[data-close-stock-edit]').forEach(function (button) {
    button.addEventListener('click', close);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
  Caixa.openStockEdit = open;
}());
