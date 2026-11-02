(function () {
  'use strict';
  const C = window.Caixa, G = C.purchaseTrips, V = G.view, el = id => document.getElementById(id);
  let wanted = null, manual = false, saved = null, optionsRequest = 0, lastStep = '';
  const panel = el('matrix-finance-panel'), form = el('me-form'), receiptCard = el('mer-card'), fields = el('me-fields');
  const tripField = V.node('label', 'mf-field vg-expense-choice', 'Viagem de compra (opcional)'), select = V.node('select'); select.id = 'me-trip'; select.setAttribute('aria-label', 'Viagem de compra'); tripField.append(select); form.before(tripField);
  const cameraHint = V.node('div', 'vg-camera-hint'); cameraHint.append(V.icon('camera'), V.node('p', '', 'Fotografe a nota ou o recibo.'));
  receiptCard.querySelector('.mer-heading').after(cameraHint);
  const actions = receiptCard.querySelector('.mer-actions'), manualButton = V.button('Preencher sem foto', () => { manual = true; render(); el('me-category').focus(); }); manualButton.classList.add('vg-manual'); receiptCard.append(manualButton);
  const photoTools = V.node('details', 'vg-photo-tools'); photoTools.append(V.node('summary', '', 'Opções do comprovante'));
  for (const [name, target] of [['Fotografar novamente', 'mer-camera'], ['Escolher outra foto', 'mer-gallery'], ['Ler novamente', 'mer-read'], ['Remover foto', 'mer-remove']]) photoTools.append(V.button(name, () => { if (!el(target).disabled) el(target).click(); }));
  receiptCard.append(photoTools);
  const labels = { camera: 'Fotografar comprovante', gallery: 'Escolher da galeria' };
  for (const [kind, text] of Object.entries(labels)) { const label = V.node('span', 'vg-receipt-button-label', text); el('mer-' + kind).append(label); }
  const galleryIcon = el('mer-gallery').firstElementChild, originalGalleryIcon = galleryIcon.cloneNode(true);
  const reading = V.node('div', 'vg-reading'); el('mer-open').querySelector('.mer-file-copy').append(reading);
  const seePhoto = V.node('span', 'vg-see-photo'); seePhoto.append(V.icon('image'), V.node('span', '', 'Ver foto')); el('mer-open').querySelector('.mer-file-copy').append(seePhoto);
  const categoryTools = V.node('div', 'vg-category-tools'); fields.before(categoryTools);
  for (const [label, symbol, match] of [['Combustível', 'fuel', /combust/i], ['Alimentação', 'food', /alimenta/i], ['Pedágio', 'road', /ped[aá]gio/i], ['Mais', 'receipt', null]]) {
    const button = V.button(label, () => {
      const select = el('me-category'), option = match && Array.from(select.options).find(o => match.test(o.text));
      if (!match) { select.closest('label').hidden = false; select.focus(); try { select.showPicker?.(); } catch {} return; }
      if (option) { select.value = option.value; select.dispatchEvent(new Event('input', { bubbles: true })); render(); }
      else G.dialogs.category(label, addCategory);
    }, false, symbol); button.dataset.categoryMatch = label; categoryTools.append(button);
  }
  function addCategory(row) { const select = el('me-category'); if (!Array.from(select.options).some(o => o.value === row.id)) select.add(new Option(row.label, row.id)); select.value = row.id; select.dispatchEvent(new Event('input', { bubbles: true })); render(); }
  const advanced = V.node('details', 'vg-extra-dates'); advanced.append(V.node('summary', '', 'Mais datas'));
  const advancedFields = V.node('fieldset', 'vg-extra-fields'); advanced.append(advancedFields);
  const dateParent = el('me-competence').closest('label'), paidParent = el('me-paid-field'), documentParent = el('me-document').closest('details');
  const restoreSlots = [dateParent, paidParent, documentParent].map(element => { const slot = document.createComment('expense-date-position'); element.before(slot); return { element, slot }; });
  const occurred = el('me-occurred').closest('label'), occurredSlot = document.createComment('expense-occurred-position'); occurred.before(occurredSlot);
  el('me-payment-fields').append(advanced);
  advanced.addEventListener('invalid', () => { advanced.open = true; }, true);
  const check = V.icon('check'); check.id = 'vg-saved-check'; check.classList.add('vg-success-icon'); check.classList.add('hidden'); el('mf-title').before(check);
  const savedHost = V.node('div', 'vg-saved-content'); el('me-success').prepend(savedHost);
  const returnButton = V.button('Voltar à viagem', () => { if (wanted) void G.open(wanted.id); }, true); returnButton.id = 'vg-expense-return'; el('me-success').append(returnButton);
  function group() { return G.state.options.find(g => g.id === select.value) || (wanted?.id === select.value ? wanted : null); }
  function active() { return Boolean(wanted && C.financeMatrix.currentTab() === 'expense' && !panel.classList.contains('hidden')); }
  function setMode(value) {
    panel.classList.toggle('is-trip-expense', value); C.elements.app.classList.toggle('is-trip-expense', value);
    if (value) { form.prepend(receiptCard); restoreSlots.forEach(item => advancedFields.append(item.element)); advancedFields.append(photoTools); form.append(advanced); advancedFields.disabled = Boolean(C.financeExpense.pending()) || C.financeExpense.busy() || Boolean(C.financeReceipts?.blocked()); }
    else { fields.after(receiptCard); receiptCard.append(photoTools); el('me-payment-fields').append(advanced); restoreSlots.forEach(item => item.slot.after(item.element)); occurredSlot.after(occurred); occurred.classList.remove('vg-attach-date'); }
  }
  function render() {
    const g = group(); if (g) wanted = g;
    const on = active(); setMode(on); check.classList.toggle('hidden', !on || !saved);
    if (!on) { cameraHint.hidden = true; manualButton.hidden = true; photoTools.hidden = true; receiptCard.hidden = false;
      reading.replaceChildren(); receiptCard.classList.remove('vg-has-receipt'); actions.classList.remove('vg-upload-actions');
      receiptCard.querySelector('.mer-heading').append(actions); actions.hidden = false; el('mer-open').setAttribute('aria-label', 'Ver resumo do comprovante');
      galleryIcon.replaceChildren(...Array.from(originalGalleryIcon.childNodes).map(node => node.cloneNode(true)));
      el('mer-confirm-field').lastChild.textContent = 'Conferi os dados da foto e a situação do pagamento.';
      document.querySelector('[data-me-status="paid"]').lastChild.textContent = 'Já paga';
      el('me-status-label').textContent = 'Situação'; el('me-amount').closest('label').firstChild.textContent = 'Valor da despesa (R$)';
      select.style.removeProperty('width');
    el('me-description').closest('label').firstChild.textContent = 'Descrição'; el('me-description').placeholder = 'Ex.: aluguel da loja'; return; }
    const snapshot = C.financeReceipts?.snapshot(), attached = Boolean(snapshot?.id), complete = Boolean(saved);
    const reviewing = attached || manual || snapshot?.enabled === false;
    galleryIcon.replaceChildren(V.icon('image'));
    if (reviewing) { occurredSlot.after(occurred); occurred.classList.remove('vg-attach-date'); } else { fields.append(occurred); occurred.classList.add('vg-attach-date'); }
    cameraHint.after(actions); actions.hidden = attached; el('mer-open').setAttribute('aria-label', 'Ver foto do comprovante');
    el('mer-confirm-field').lastChild.textContent = 'Conferi os dados';
    categoryTools.hidden = !manual || attached;
    el('me-category').closest('label').hidden = false;
    categoryTools.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Array.from(el('me-category').options).find(o => o.value === el('me-category').value)?.text === b.dataset.categoryMatch)));
    const step = complete ? 'saved' : reviewing ? 'review' : 'attach'; panel.dataset.tripExpenseStep = step;
    if (lastStep !== step) { panel.scrollTop = 0; lastStep = step; }
    el('mf-title').textContent = complete ? 'Gasto salvo' : attached ? 'Conferir gasto' : 'Novo gasto';
    el('mf-tool-subtitle').textContent = complete ? 'Vinculado à viagem' : '';
    el('mf-tool-subtitle').classList.toggle('hidden', !complete);
    el('me-status-label').textContent = 'Pagamento'; el('me-amount').closest('label').firstChild.textContent = 'Valor';
    if (!reviewing) el('me-note').replaceChildren(V.icon('info'), V.node('span', '', 'A leitura preenche uma sugestão pra você conferir.'));
    tripField.hidden = complete; select.disabled = Boolean(C.financeExpense.pending()) || C.financeExpense.busy();
    select.style.width = Math.max(170, Math.min(300, (wanted.code + ' · ' + wanted.name).length * 8 + 48)) + 'px';
    el('mer-hint').textContent = attached ? '' : 'Fotografe ou anexe';
    cameraHint.hidden = attached; actions.classList.toggle('vg-upload-actions', !attached); manualButton.hidden = attached;
    photoTools.hidden = !attached;
    receiptCard.classList.toggle('vg-has-receipt', attached); receiptCard.hidden = (manual || snapshot?.enabled === false) && !attached;
    reading.replaceChildren();
    if (attached) {
      el('mer-file-name').textContent = snapshot.status === 'parsed' ? 'Leitura da IA' : 'Comprovante anexado';
      for (const text of [snapshot.merchant, snapshot.document_date && Pday(snapshot.document_date), snapshot.amount && V.money(snapshot.amount)]) if (text) reading.append(V.node('span', '', text));
    }
    el('me-save-label').textContent = C.financeExpense.busy() ? 'Salvando…' : C.financeExpense.pending() ? 'Confirmar a mesma tentativa' : 'Salvar gasto';
    document.querySelector('[data-me-status="paid"]').lastChild.textContent = 'Pago na hora';
    const description = el('me-description').closest('label'); description.firstChild.textContent = attached ? 'Estabelecimento' : 'Descrição (opcional)'; el('me-description').placeholder = 'Ex.: abastecimento na ida';
  }
  const Pday = date => window.FarejadorTime.formatCivilDate(String(date).slice(0, 10));
  async function load(attempt) {
    const ticket = ++optionsRequest, original = attempt?.group_id || wanted?.id || select.value || '';
    try {
      const rows = await G.loadOptions(); if (ticket !== optionsRequest) return;
      select.replaceChildren(new Option('Sem viagem', ''));
      rows.filter(g => g.status === 'open' || g.id === original).forEach(g => {
        const option = new Option(g.code + ' · ' + g.name + (g.status === 'closed' ? ' (fechada)' : ''), g.id); option.disabled = g.status === 'closed'; select.add(option);
      });
      select.value = original; wanted = rows.find(g => g.id === original) || null; render();
      select.add(new Option('＋ Nova viagem…', '__new__'));
      if (!Array.from(el('me-category').options).some(o => o.value === '__new__')) el('me-category').add(new Option('＋ Nova modalidade…', '__new__'));
    } catch { C.showToast('Não foi possível carregar as viagens. Atualize antes de vincular o gasto.'); }
  }
  function reset() { wanted = null; manual = false; saved = null; lastStep = ''; optionsRequest++; select.value = ''; savedHost.replaceChildren(); setMode(false); }
  function launch(g) {
    const pending = C.financeExpense.pending();
    if (pending && pending.group_id !== g.id) { C.showToast('Confirme a despesa pendente no Financeiro antes de iniciar outro gasto.'); return; }
    if (!pending && C.financeExpense.hasDraft() && !window.confirm('Há uma despesa em preenchimento. Descartar o rascunho para lançar este gasto?')) return;
    if (!pending) C.financeExpense.reset(); wanted = g; saved = null; manual = false; lastStep = '';
    if (!select.querySelector('option[value="' + g.id + '"]')) select.add(new Option(g.code + ' · ' + g.name, g.id));
    select.value = g.id; C.financeMatrix.open('expense');
  }
  function save(expense, body) {
    if (!body.group_id) return; saved = { ...body, ...expense }; wanted = group() || wanted;
    const snapshot = C.financeReceipts.snapshot(), box = V.card('vg-saved-expense');
    box.append(V.icon(V.categoryIcon(expense.category || body.category)), V.node('h3', '', Array.from(el('me-category').options).find(o => o.value === body.category)?.text || body.category),
      V.node('strong', 'vg-total', V.money(expense.amount || body.amount)), V.node('p', '', body.description || ''),
      V.node('p', '', Pday(body.document_date) + ' · ' + (body.payment_status === 'paid' ? 'Pago na hora' : 'A pagar')),
      V.node('span', 'vg-badge', wanted ? wanted.code + ' · ' + wanted.name : 'Viagem de compra'));
    savedHost.replaceChildren(box);
    if (body.receipt_id) {
      const photo = V.card('vg-saved-photo'); photo.append(V.node('h3', '', 'Comprovante anexado'));
      if (snapshot.preview) { const image = V.node('img'); image.src = snapshot.preview; image.alt = 'Comprovante do gasto salvo'; photo.append(image); }
      photo.append(V.button('Ver comprovante', () => G.receipt({ receipt_id: body.receipt_id }), false, 'image'), V.node('p', 'vg-info', 'Disponível neste gasto do Financeiro.')); savedHost.append(photo);
    }
    render();
  }
  select.addEventListener('change', () => { if (C.financeExpense.pending()) return;
    if (select.value === '__new__') { select.value = wanted?.id || ''; void G.dialogs.create(null, g => { wanted = g; select.add(new Option(g.code + ' · ' + g.name, g.id)); select.value = g.id; render(); }); return; }
    wanted = group(); manual = false; render(); });
  el('me-category').addEventListener('change', () => { if (el('me-category').value === '__new__') { el('me-category').value = ''; G.dialogs.category('', addCategory); } });
  el('mf-back').addEventListener('click', event => { if (!active()) return; event.preventDefault(); event.stopImmediatePropagation(); if (!C.financeClean.blockNavigation()) void G.open(wanted.id); }, true);
  el('mer-open').addEventListener('click', event => {
    if (!active()) return; event.preventDefault(); event.stopImmediatePropagation();
    const snapshot = C.financeReceipts.snapshot(); if (snapshot?.id) void window.ExpenseReceiptViewer.show('/api/caixa/financeiro-despesas/comprovantes/' + snapshot.id + '/previa', C.authenticatedFetch);
  }, true);
  el('me-new').addEventListener('click', () => { saved = null; manual = false; });
  form.addEventListener('change', () => { if (active()) render(); });
  G.expense = C.purchaseTripExpense = { launch, load, render, saved: save, reset, payload: () => select.value ? { group_id: select.value } : {},
    sync: tab => { if (tab !== 'finance-expense') { setMode(false); tripField.hidden = false; } else render(); } };
}());
