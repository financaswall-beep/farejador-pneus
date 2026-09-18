(function () {
  'use strict';
  const C = window.Caixa, P = C.purchases, s = P.state;
  P.formError = function (message) { const node = P.id('form-error'); node.textContent = message; node.hidden = !message; };
  P.changed = function () {
    s.preview = null; P.id('verified').hidden = true; P.persist(); P.footer();
  };
  P.supplierName = function () { return s.draft.newSupplier ? s.draft.supplierName : s.suppliers.find(function (row) { return row.id === s.draft.supplier; })?.name || 'Fornecedor selecionado'; };
  P.totals = function () {
    if (!s.draft) return;
    const d = s.draft, lot = d.mode === 'lot';
    const quantity = lot ? Number(d.lot.quantity) : d.items.reduce(function (sum, item) { return sum + Number(item.quantity || 0); }, 0);
    const products = lot ? Number(d.lot.total_cost) : d.items.reduce(function (sum, item) { return sum + Math.round(Number(item.unit_cost || 0) * 100) * Number(item.quantity || 0); }, 0) / 100;
    P.id('total-items').textContent = d.step === 1 ? 'Escolha um fornecedor' : quantity + ' pneus · ' + (lot ? '1 lote' : d.items.length + ' itens');
    P.id('total-label').textContent = s.preview ? 'Total da compra' : 'Total dos produtos';
    P.id('total').textContent = P.money(s.preview ? s.preview.values.totalCents / 100 : products);
  };
  P.footer = function () {
    if (!s.draft) return;
    const step = s.draft.step;
    P.id('continue').textContent = s.busy ? 'Aguarde…' : s.pending ? 'Tentar confirmar novamente'
      : step === 1 ? 'Continuar para pneus →' : step === 2 ? 'Continuar para revisão →' : s.preview ? 'Registrar compra' : 'Conferir valores';
    P.id('continue').disabled = s.busy || !s.contextReady;
    P.id('fields').disabled = s.busy || !!s.pending;
    P.id('back').disabled = s.busy || !!s.pending;
    P.id('discard').disabled = s.busy || !!s.pending;
    P.id('pause').disabled = s.busy;
    P.id('footer-note').textContent = s.pending ? 'Os dados estão preservados para retomar a mesma tentativa.'
      : step === 1 ? 'Selecione ou cadastre o fornecedor.' : step === 2 ? 'Frete, desconto e pagamento na próxima etapa.'
        : s.preview ? 'Confira o pagamento e a chegada antes de registrar.' : 'Confira o total antes de registrar a compra.';
  };
  P.renderStep = function () {
    const d = s.draft;
    [1, 2, 3].forEach(function (step) {
      P.id('step-' + step).hidden = step !== d.step;
      const badge = document.querySelector('[data-pc-step="' + step + '"]');
      badge.classList.toggle('is-current', step === d.step); badge.classList.toggle('is-done', step < d.step);
      badge.querySelector('b').textContent = step < d.step ? '✓' : step;
      if (step === d.step) badge.setAttribute('aria-current', 'step'); else badge.removeAttribute('aria-current');
    });
    P.id('step-label').textContent = d.step + ' de 3 · ' + ['Fornecedor', 'Pneus', 'Revisão'][d.step - 1];
    P.id('supplier').disabled = d.newSupplier; P.id('new-supplier').hidden = !d.newSupplier;
    P.id('supplier-new-toggle').textContent = d.newSupplier ? 'Escolher fornecedor cadastrado' : '＋ Novo fornecedor';
    P.id('chosen-supplier').textContent = P.supplierName();
    const lot = d.mode === 'lot'; P.id('by-items').hidden = lot; P.id('by-lot').hidden = !lot;
    P.id('mode-items').setAttribute('aria-pressed', String(!lot)); P.id('mode-lot').setAttribute('aria-pressed', String(lot));
    if (d.step === 2) P.renderItems();
    if (d.step === 3) P.renderReview();
    P.totals(); P.footer(); P.formError('');
  };
  function newDraft() {
    const today = P.today();
    return { key: crypto.randomUUID(), step: 1, mode: 'items', supplier: '', newSupplier: false,
      supplierName: '', supplierPhone: '', supplierDocument: '', items: [], installments: [],
      lot: { description: '', vehicle_type: 'mixed', quantity: 1, total_cost: '' },
      review: { 'purchased-date': today, freight: '0', discount: '0', reference: '', payment: 'paid',
        'payment-method': 'pix', 'paid-date': today, 'due-date': '', 'receipt-status': 'pending', 'received-date': today, notes: '' } };
  }
  P.startFromPrice = async function (row, quantity) {
    if (s.busy || s.pending) { P.notice('Retome a confirmação pendente em Nova compra antes de usar esta referência.'); return; }
    if (row.supplier_archived) { P.notice('Este fornecedor foi arquivado. Escolha um fornecedor ativo.'); return; }
    const previous = s.draft;
    const context = await P.request('/contexto');
    if (s.busy || s.pending || s.draft !== previous) return;
    if (!context.suppliers?.some(function (supplier) { return supplier.id === row.supplier_id; })) {
      P.notice('O fornecedor não está mais ativo. Atualize a comparação e selecione outro.'); return;
    }
    if (previous && !window.confirm('Substituir o rascunho atual por esta compra?')) return;
    s.preview = null; s.draft = newDraft(); s.draft.step = 2; s.draft.supplier = row.supplier_id;
    s.draft.items = [{ measure: row.measure, brand: row.brand, vehicle_type: row.vehicle_type || null,
      tire_condition: row.tire_condition, quantity: quantity, unit_cost: '' }];
    P.selectListTab('pending', false); P.persist(); await P.start();
    if (s.draft) P.formError('Fornecedor, pneu e quantidade preenchidos. Confirme o custo atual com o fornecedor.');
  };
  P.start = async function () {
    if (s.busy || !C.canModule('purchases')) return;
    if (s.pending?.suffix === '/confirmar') { P.openDetail(s.pending.detail, true); return; }
    P.restore(); s.draft = s.draft || newDraft(); s.contextReady = false;
    P.id('home').hidden = true; P.id('wizard').hidden = false; P.notice('');
    P.id('supplier-name').value = s.draft.supplierName; P.id('supplier-phone').value = s.draft.supplierPhone; P.id('supplier-document').value = s.draft.supplierDocument;
    Object.entries({ description: 'description', vehicle: 'vehicle_type', quantity: 'quantity', cost: 'total_cost' }).forEach(function (entry) { P.id('lot-' + entry[0]).value = s.draft.lot[entry[1]]; });
    P.renderStep(); P.persist();
    void P.loadPurchaseCatalog();
    try {
      const data = await P.request('/contexto');
      if (!Array.isArray(data.suppliers) || typeof data.credit_enabled !== 'boolean') throw new Error('invalid_response');
      s.suppliers = data.suppliers || []; s.credit = data.credit_enabled === true; s.contextReady = true;
      P.id('supplier').replaceChildren(new Option('Selecione um fornecedor', ''));
      s.suppliers.forEach(function (row) { P.id('supplier').append(new Option(row.name, row.id)); });
      if (!s.draft) return;
      P.id('supplier').value = s.draft.supplier;
      P.renderStep();
    } catch (error) {
      if (error.message !== 'invalid_session') P.formError('Não foi possível carregar os fornecedores. Feche e abra a compra para tentar novamente. Seu rascunho foi preservado.');
    }
  };
  function validateStep() {
    const d = s.draft;
    if (d.step === 1) {
      if (!(d.newSupplier ? d.supplierName.trim() : P.id('supplier').value)) { P.formError('Selecione um fornecedor ou informe o nome do novo.'); return false; }
    }
    if (d.step === 2 && d.mode === 'items' && !d.items.length) { P.formError('Adicione pelo menos um pneu do catálogo.'); return false; }
    const invalid = [...P.id('step-' + d.step).querySelectorAll('input,select,textarea')].find(function (input) { return input.offsetParent !== null && !input.checkValidity(); });
    if (invalid) { invalid.reportValidity(); return false; }
    return true;
  }
  P.id('form').noValidate = true;
  P.id('form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (s.busy || !s.contextReady || !s.draft) return;
    if (!s.pending && !validateStep()) return;
    if (s.draft.step < 3 && !s.pending) { s.draft.step++; P.changed(); P.renderStep(); return; }
    P.formError('');
    if (!s.preview && !s.pending) {
      const session = s.session;
      s.busy = true; P.footer();
      try { await P.verify(); } catch (error) { if (error.message !== 'invalid_session') P.formError(P.message(error)); }
      finally { if (session === s.session) { s.busy = false; P.footer(); } }
      return;
    }
    const preview = s.preview;
    const operation = P.send(preview?.suffix, preview?.body); P.footer();
    try {
      const result = await operation; if (!result) return;
      P.id('wizard').hidden = true; P.id('home').hidden = false;
      P.notice('Compra ' + (result.order_code || result.purchase_id.slice(0, 8)) + ' registrada. ' +
        (result.stock_applied ? 'Recebimento confirmado.' : 'Aguardando conferência de chegada.') +
        (result.catalog_blockers?.length ? ' Há pneus que precisam de configuração no Catálogo antes da venda.' : '') +
        (result.lot_code && result.stock_applied ? ' Lote ' + result.lot_code + ' disponível para triagem no web.' : ''), true);
      void P.load(); void P.summary();
    } catch (error) { if (error.message !== 'invalid_session') P.formError(P.message(error)); }
    finally { P.footer(); }
  });
  P.id('new').addEventListener('click', P.start);
  P.id('back').addEventListener('click', function () {
    if (s.draft.step > 1) { s.draft.step--; P.changed(); P.renderStep(); }
    else P.id('pause').click();
  });
  P.id('pause').addEventListener('click', function () {
    P.persist(); P.id('wizard').hidden = true; P.id('home').hidden = false;
    P.notice(s.pending ? 'Uma confirmação está pendente. Toque em Nova compra para retomar a mesma tentativa.' : 'Rascunho salvo nesta aba. Toque em Nova compra para continuar.', true);
  });
  P.id('discard').addEventListener('click', function () {
    if (s.pending || s.busy || !window.confirm('Descartar o rascunho desta compra?')) return;
    s.draft = null; s.preview = null; P.persist(); P.id('wizard').hidden = true; P.id('home').hidden = false; P.notice('');
  });
  P.id('supplier-new-toggle').addEventListener('click', function () { s.draft.newSupplier = !s.draft.newSupplier; P.changed(); P.renderStep(); });
  P.id('change-supplier').addEventListener('click', function () { s.draft.step = 1; P.changed(); P.renderStep(); });
  P.id('supplier').addEventListener('change', function () { s.draft.supplier = this.value; P.changed(); });
  ['Name', 'Phone', 'Document'].forEach(function (key) {
    P.id('supplier-' + key.toLowerCase()).addEventListener('input', function () { s.draft['supplier' + key] = this.value; P.changed(); });
  });
  Object.entries({ description: 'description', vehicle: 'vehicle_type', quantity: 'quantity', cost: 'total_cost' }).forEach(function (entry) {
    P.id('lot-' + entry[0]).addEventListener('input', function () { s.draft.lot[entry[1]] = this.value; P.changed(); P.totals(); });
  });
}());
