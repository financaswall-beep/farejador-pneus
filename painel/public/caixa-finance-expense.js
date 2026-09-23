(function () {
  'use strict';
  const C = window.Caixa, T = window.FarejadorTime, el = id => document.getElementById(id);
  const storageKey = 'farejador.finance.expense-attempt.v1';
  let request, attempt = null, sending = false, initialized = false, status = 'paid', back = 'summary', saved = null;
  const hide = (id, value) => el(id).classList.toggle('hidden', value);
  const identity = () => [C.scope(), C.stored(C.keys.user), C.stored(C.keys.name)].join('|');
  const allowed = () => C.token() && !C.isPartner() && C.canModule('financeiro') && C.stored(C.keys.role) === 'owner';
  function cancel() { if (request) request.abort(); request = null; C.financeReceipts?.cancel(); }
  function reset() { cancel(); C.financeReceipts?.reset(); attempt = null; sending = false; initialized = false; saved = null; el('me-form').reset(); hide('me-form', true); hide('me-success', true); }
  function controls() {
    document.querySelectorAll('[data-me-status]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.meStatus === status)));
    hide('me-paid-field', status !== 'paid'); hide('me-due-field', status !== 'pending');
    el('me-paid').required = status === 'paid'; el('me-due').required = status === 'pending';
    C.financeReceipts?.setLocked(Boolean(attempt) || sending);
    el('me-fields').disabled = Boolean(attempt) || sending || Boolean(C.financeReceipts?.blocked());
    el('me-payment-fields').disabled = el('me-fields').disabled;
    el('me-save').disabled = sending || (!attempt && Boolean(C.financeReceipts?.blocked()));
    el('me-save-label').textContent = sending ? 'Salvando…' : attempt ? 'Confirmar a mesma tentativa' : 'Salvar despesa';
    el('me-note').textContent = status === 'paid' ? 'A despesa entra no resultado da competência. O pagamento registra a saída do caixa.'
      : 'A despesa entra no resultado da competência e em Contas a pagar. O caixa muda quando o pagamento for registrado.';
    if (!status) el('me-note').textContent = 'Selecione Já paga ou A pagar. A foto não confirma o pagamento.';
    el('me-document-label').textContent = el('me-document').value ? T.formatDate(el('me-document').value) : 'Confira a data';
  }
  function restoreFields(data) {
    status = data.payment_status;
    el('me-amount').value = Number(data.amount).toFixed(2).replace('.', ',');
    el('me-category').value = data.category; el('me-description').value = data.description || '';
    el('me-occurred').value = T.dateKey(data.occurred_at); el('me-competence').value = data.competence_month.slice(0, 7);
    el('me-document').value = data.document_date; el('me-paid').value = data.paid_at ? T.dateKey(data.paid_at) : '';
    el('me-due').value = data.due_date || '';
  }
  function initialize() {
    if (initialized) return;
    const today = T.dateKey(new Date());
    el('me-form').reset(); status = 'paid';
    ['me-occurred', 'me-paid', 'me-document'].forEach(id => { el(id).value = today; el(id).max = today; });
    el('me-competence').value = today.slice(0, 7); el('me-competence').max = today.slice(0, 7);
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (stored?.identity === identity() && stored.body?.idempotency_key && ['paid', 'pending'].includes(stored.body.payment_status)) attempt = stored.body;
    } catch { /* Nenhuma tentativa recuperável. A persistência é obrigatória antes do envio. */ }
    initialized = true;
  }
  async function load() {
    cancel(); if (!allowed()) return;
    initialize(); controls();
    if (saved) { hide('me-success', false); hide('me-form', true); hide('me-loading', true); return; }
    const controller = new AbortController(); request = controller;
    const session = C.sessionFingerprint();
    hide('me-loading', false); hide('me-load-error', true); hide('me-success', true); hide('me-form', true);
    try {
      const response = await C.authenticatedFetch('/api/caixa/financeiro-despesas/categorias', { signal: controller.signal });
      const body = await C.json(response);
      if (!response.ok || !Array.isArray(body.categories)) throw Error(body.error || 'categories_unavailable');
      if (controller.signal.aborted || session !== C.sessionFingerprint()) return;
      const selected = attempt?.category || el('me-category').value;
      el('me-category').replaceChildren(new Option('Selecione', ''));
      body.categories.forEach(row => { if (!row.archived) el('me-category').add(new Option(row.label, row.id)); });
      // Uma categoria pode ter sido arquivada depois do primeiro envio; o replay mantém o corpo original.
      if (attempt && !body.categories.some(r => r.id === selected)) el('me-category').add(new Option(selected + ' (tentativa anterior)', selected));
      el('me-category').value = selected;
      if (attempt) {
        restoreFields(attempt); el('me-error').textContent = 'Há uma tentativa sem confirmação. Confira o envio usando o mesmo lançamento para evitar duplicidade.'; hide('me-error', false);
      }
      controls(); hide('me-form', false); C.financeMatrix.updated();
      await C.financeReceipts?.load(body, attempt);
    } catch (error) {
      if (controller.signal.aborted || session !== C.sessionFingerprint() || error.message === 'invalid_session') return;
      el('me-load-error').textContent = error.message === 'expenses_disabled' ? 'O lançamento de despesas está desativado para esta operação.' : 'Não foi possível carregar as categorias. Toque em Atualizar para tentar novamente.';
      hide('me-load-error', false);
    } finally { if (request === controller) { request = null; hide('me-loading', true); } }
  }
  function moneyInput() {
    const raw = el('me-amount').value.trim();
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(raw)) throw Error('Informe o valor em reais, com até duas casas decimais.');
    const value = Number(raw.replaceAll('.', '').replace(',', '.'));
    if (!(value > 0) || !Number.isSafeInteger(Math.round(value * 100))) throw Error('Informe um valor válido maior que zero.');
    return value;
  }
  function civil(value) {
    const d = new Date(value + 'T12:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value) throw Error('Confira as datas informadas.');
    return value;
  }
  function payload() {
    if (!['paid', 'pending'].includes(status)) throw Error('Selecione se a despesa já foi paga ou está a pagar.');
    const today = T.dateKey(new Date()), instant = day => day === today ? new Date().toISOString() : new Date(day + 'T12:00:00-03:00').toISOString();
    const occurred = civil(el('me-occurred').value), document = civil(el('me-document').value), competence = civil(el('me-competence').value + '-01');
    if (occurred > today || document > today || competence > today) throw Error('A despesa, o documento e a competência não podem estar no futuro.');
    const data = { amount: moneyInput(), category: el('me-category').value, description: el('me-description').value.trim() || null,
      payment_status: status, occurred_at: instant(occurred), document_date: document, competence_month: competence,
      idempotency_key: 'app-expense-' + crypto.randomUUID() };
    if (status === 'paid') {
      const paid = civil(el('me-paid').value); if (paid > today) throw Error('O pagamento não pode estar no futuro.'); data.paid_at = instant(paid);
    } else data.due_date = civil(el('me-due').value);
    return { ...data, ...C.financeReceipts?.payload() };
  }
  el('me-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!allowed() || sending || saved || (!attempt && !el('me-form').reportValidity())) return;
    hide('me-error', true);
    const session = C.sessionFingerprint();
    try {
      if (!attempt) {
        const body = payload();
        try { sessionStorage.setItem(storageKey, JSON.stringify({ identity: identity(), body })); }
        catch { throw Error('Não foi possível guardar a confirmação neste navegador. Libere o armazenamento e tente novamente.'); }
        attempt = body;
      }
      sending = true; controls();
      const submitted = attempt;
      const response = await C.authenticatedFetch('/api/caixa/financeiro-despesas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submitted) });
      const result = await C.json(response);
      if (session !== C.sessionFingerprint()) return;
      if (!response.ok) {
        if (['expense_receipt_already_linked', 'expense_receipt_processing'].includes(result.error)) {
          sessionStorage.removeItem(storageKey); attempt = null;
          throw Error(result.error === 'expense_receipt_already_linked' ? 'Este comprovante já pertence a uma despesa. Atualize para consultar.' : 'A leitura ainda está em andamento. Atualize e aguarde antes de salvar.');
        }
        if (response.status === 400 || response.status === 403 || response.status === 404) {
          sessionStorage.removeItem(storageKey); attempt = null;
          throw Error(result.error === 'category_invalid' ? 'A categoria foi arquivada. Atualize e selecione outra categoria.'
            : response.status === 403 ? 'Seu acesso não permite lançar despesas.' : 'Confira valor, categoria e datas. O lançamento foi recusado.');
        }
        throw Error('Não foi possível confirmar o lançamento. Tente confirmar novamente; a mesma tentativa será usada.');
      }
      if (result.created !== true || !result.expense?.id) throw Error('O servidor não confirmou o lançamento. Confirme novamente com a mesma tentativa.');
      saved = submitted; attempt = null; sessionStorage.removeItem(storageKey);
      C.financeReceipts?.saved(); el('me-saved-receipt').replaceChildren();
      if (submitted.receipt_id) C.financeReceipts.attachment(el('me-saved-receipt'), result.expense.id);
      el('me-success-copy').textContent = C.currency.format(submitted.amount) + (submitted.payment_status === 'paid' ? ' registrados. A despesa e o pagamento estão no financeiro.' : ' registrados em Contas a pagar. Nenhuma saída de caixa foi registrada.');
      el('me-view').textContent = submitted.payment_status === 'paid' ? 'Ver no extrato' : 'Ver contas a pagar';
      hide('me-form', true); hide('me-success', false);
      if (C.financeMatrix.currentTab() !== 'expense' && !el('matrix-finance-panel').classList.contains('hidden')) void C.financeMatrix.load();
    } catch (error) {
      if (session !== C.sessionFingerprint() || error.message === 'invalid_session') return;
      el('me-error').textContent = attempt ? 'Envio sem confirmação. ' + (error.message.startsWith('Não foi possível confirmar') || error.message.startsWith('O servidor') ? error.message : 'Toque em confirmar a mesma tentativa para consultar ou concluir este lançamento sem duplicá-lo.') : error.message;
      hide('me-error', false);
    } finally { if (session === C.sessionFingerprint()) { sending = false; controls(); } }
  });
  document.querySelectorAll('[data-me-status]').forEach(b => b.addEventListener('click', () => { status = b.dataset.meStatus; controls(); }));
  el('me-document').addEventListener('change', controls);
  el('me-document').addEventListener('invalid', () => { el('me-document').closest('details').open = true; });
  el('me-new').addEventListener('click', () => { C.financeReceipts?.reset(true); initialized = false; saved = null; hide('me-error', true); void load(); });
  el('me-view').addEventListener('click', () => {
    if (!saved) return;
    if (saved.payment_status === 'paid') el('mf-month').value = T.dateKey(saved.paid_at).slice(0, 7);
    C.financeMatrix.open(saved.payment_status === 'paid' ? 'statement' : 'accounts');
  });
  C.financeExpense = { load, cancel, reset, refresh: controls, status: () => status,
    setStatus: value => { status = value; controls(); }, setReturnTab: tab => { back = tab; }, returnTab: () => back };
}());
