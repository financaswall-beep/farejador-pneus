(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const modal = byId('stock-price-modal');
  const form = byId('stock-price-form');
  const state = { row: null };

  function isOwner() {
    return Caixa.stored(Caixa.keys.role) === 'owner';
  }

  function parseMoney(value) {
    let normalized = String(value || '').trim().replace(/R\$|\s/g, '');
    if (normalized.includes(',') && normalized.includes('.')) normalized = normalized.replace(/\./g, '');
    normalized = normalized.replace(',', '.');
    const amount = Number(normalized);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const cents = Math.round(amount * 100);
    return Math.abs(amount * 100 - cents) < 1e-7 ? cents / 100 : null;
  }

  function close() {
    modal.classList.add('hidden');
    byId('stock-price-error').textContent = '';
    state.row = null;
  }

  function open(row) {
    if (!isOwner()) {
      Caixa.showToast('Somente o proprietário pode alterar o preço oficial.');
      return;
    }
    state.row = row;
    form.reset();
    const identity = [row.brand, row.tire_size || row.item_name].filter(Boolean).join(' ') || 'Produto selecionado';
    byId('stock-price-unit').textContent = Caixa.stored(Caixa.keys.store) || 'Unidade logada';
    byId('stock-price-product').textContent = identity;
    byId('stock-price-current').textContent = row.sale_price == null
      ? 'Não definido' : Caixa.currency.format(Number(row.sale_price));
    byId('stock-price-value').value = row.sale_price == null
      ? '' : Number(row.sale_price).toFixed(2).replace('.', ',');
    byId('stock-price-error').textContent = '';
    modal.classList.remove('hidden');
    byId('stock-price-value').focus({ preventScroll: true });
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!state.row || !isOwner()) return;
    const salePrice = parseMoney(byId('stock-price-value').value);
    const reason = byId('stock-price-reason').value.trim();
    const error = byId('stock-price-error');
    if (salePrice == null) { error.textContent = 'Informe um preço maior que zero, com no máximo dois centavos.'; return; }
    if (reason.length < 3) { error.textContent = 'Informe o motivo da alteração.'; return; }
    const submit = byId('stock-price-submit');
    submit.disabled = true; error.textContent = '';
    try {
      const path = `operacao/estoque/${encodeURIComponent(state.row.stock_id)}/preco`;
      const response = await Caixa.authenticatedFetch(Caixa.operationPath(path), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sale_price: salePrice, reason: reason }),
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      close();
      Caixa.showToast(payload.changed ? 'Preço oficial atualizado.' : 'Esse já era o preço oficial.');
      if (Caixa.loadStock) await Caixa.loadStock();
      if (Caixa.isPartner() && Caixa.refreshStockDetail) await Caixa.refreshStockDetail();
      if (Caixa.loadOperationCatalog) await Caixa.loadOperationCatalog(1);
      if (Caixa.loadCatalog) void Caixa.loadCatalog();
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      const code = failure instanceof Error ? failure.message : 'request_failed';
      error.textContent = code === 'owner_required' || code === 'partner_forbidden_owner_only'
        ? 'Somente o proprietário pode alterar o preço oficial.'
        : code === 'catalog_product_not_found'
          ? 'Este item ainda não possui produto correspondente no catálogo da Matriz.'
          : 'Não foi possível alterar o preço. Confira os dados e tente novamente.';
    } finally {
      submit.disabled = false;
    }
  });

  document.querySelectorAll('[data-close-stock-price]').forEach(function (button) {
    button.addEventListener('click', close);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
  Caixa.openStockPrice = open;
  Caixa.isOwner = isOwner;
}());
