(function () {
  'use strict';
  const C = window.Caixa, T = window.FarejadorTime, el = id => document.getElementById(id);
  const base = '/api/caixa/financeiro-despesas', storage = 'farejador.expense-receipt-draft.v1';
  const fields = ['me-amount', 'me-category', 'me-description', 'me-occurred', 'me-competence', 'me-document', 'me-paid', 'me-due'];
  let receipt = null, busy = false, locked = false, enabled = false, ai = false, request, preview, timer, applied;
  const identity = () => [C.scope(), C.stored(C.keys.user), C.stored(C.keys.name)].join('|');
  const hide = (id, value) => el(id).classList.toggle('hidden', value);
  const message = text => { el('mer-status').textContent = text; };
  function persist() {
    if (!receipt || locked) return;
    sessionStorage.setItem(storage, JSON.stringify({ identity: identity(), id: receipt.id, fields: Object.fromEntries(fields.map(id => [id, el(id).value])),
      status: C.financeExpense.status(), confirmed: el('mer-confirm').checked, applied }));
  }
  function cancel() { request?.abort(); request = null; clearTimeout(timer); busy = false; }
  function reset(clear = false) {
    cancel(); if (preview) URL.revokeObjectURL(preview); preview = null; receipt = null; applied = null;
    el('mer-preview').removeAttribute('src'); el('mer-confirm').checked = false; message('');
    if (clear) sessionStorage.removeItem(storage);
    window.ExpenseReceiptViewer.close(); render();
  }
  function render() {
    hide('mer-card', !enabled); hide('mer-photo', !receipt); hide('mer-confirm-field', !receipt || Boolean(receipt.expense_id));
    hide('mer-read', !receipt || !ai || Boolean(receipt.expense_id));
    hide('mer-remove', !receipt); hide('mer-preview', !preview);
    ['mer-camera', 'mer-gallery', 'mer-read', 'mer-remove'].forEach(id => { el(id).disabled = busy || locked; });
    C.financeExpense?.refresh();
  }
  function apply(row) {
    if (row.status !== 'parsed' || applied === row.reading_id || locked) return;
    el('me-amount').value = Number(row.amount).toFixed(2).replace('.', ',');
    el('me-category').value = row.category;
    el('me-description').value = row.merchant || '';
    if (row.document_date && row.document_date <= T.dateKey(new Date())) {
      el('me-document').value = row.document_date; el('me-occurred').value = row.document_date; el('me-competence').value = row.document_date.slice(0, 7);
    } else { el('me-document').value = ''; el('me-occurred').value = ''; el('me-competence').value = ''; }
    applied = row.reading_id; el('mer-confirm').checked = false;
  }
  function describe() {
    message(receipt.expense_id ? (receipt.expense_removed ? 'Este comprovante pertence a uma despesa removida. Consulte o financeiro antes de lançar novamente.' : 'Este comprovante já está vinculado a uma despesa. Não será lançado novamente.')
      : receipt.processing ? 'A leitura está em andamento. Aguarde…'
        : receipt.status === 'parsed' ? 'Sugestão preenchida. Confira valor, categoria, datas e escolha se já foi paga.' + (receipt.confidence == null || Number(receipt.confidence) < 0.7 ? ' Leitura com baixa confiança.' : '')
          : receipt.status ? 'Não foi possível preencher com segurança. A foto foi salva; complete os campos ou tente ler novamente.'
            : ai ? 'Foto salva. Pronta para leitura.' : 'Foto salva. Preencha os campos para lançar a despesa.');
  }
  async function json(path, options, controller) {
    const response = await C.authenticatedFetch(base + path, { ...options, signal: controller.signal });
    const data = await C.json(response);
    if (!response.ok) throw Error(data.error || 'receipt_unavailable');
    return data;
  }
  async function picture(controller) {
    const response = await C.authenticatedFetch(base + '/comprovantes/' + receipt.id + '/previa', { signal: controller.signal });
    if (!response.ok) return;
    const blob = await response.blob(); if (controller.signal.aborted) return;
    if (preview) URL.revokeObjectURL(preview); preview = URL.createObjectURL(blob); el('mer-preview').src = preview;
  }
  function context() { cancel(); request = new AbortController(); busy = true; render(); return request; }
  function poll(controller) {
    if (!receipt?.processing || controller.signal.aborted) return;
    timer = setTimeout(async () => {
      try {
        const data = await json('/comprovantes/' + receipt.id, {}, controller);
        if (controller.signal.aborted) return; receipt = data.receipt; apply(receipt); persist(); describe(); render(); poll(controller);
      } catch { if (!controller.signal.aborted) { message('Não foi possível acompanhar a leitura. Toque em Atualizar para consultar.'); render(); } }
    }, 3000);
  }
  async function read(retry = false, current) {
    const controller = current || context();
    try {
      message('Lendo o comprovante…');
      const data = await json('/comprovantes/' + receipt.id + '/ler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retry }) }, controller);
      if (controller.signal.aborted) return; receipt = data.receipt; apply(receipt); persist(); describe(); poll(controller);
    } catch {
      if (!controller.signal.aborted) { receipt.processing = true; message('Conexão interrompida. Consultando a leitura antes de continuar…'); poll(controller); }
    } finally { if (!controller.signal.aborted) { busy = false; render(); } }
  }
  async function upload(file) {
    if (!file || locked || busy) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) { message('Use uma foto JPG, PNG ou WebP de até 8 MB.'); return; }
    const controller = context(); message('Salvando foto…');
    try {
      const data = await json('/comprovantes', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }, controller);
      if (controller.signal.aborted) return;
      receipt = data.receipt; applied = null; C.financeExpense.setStatus(''); el('mer-confirm').checked = false; persist();
      await picture(controller); if (controller.signal.aborted) return;
      if (ai && !receipt.status && !receipt.expense_id) await read(false, controller);
      else { apply(receipt); persist(); describe(); poll(controller); }
    } catch (error) {
      if (!controller.signal.aborted) message(error.message === 'receipt_belongs_to_trip' ? 'Essa foto já está na Logística. Confira a despesa naquela rota.'
        : error.message === 'receipt_rate_limit' ? 'Muitas tentativas. Aguarde alguns minutos.' : 'Não foi possível concluir. Tente a mesma foto novamente; o arquivo não será duplicado.');
    } finally { if (!controller.signal.aborted) { busy = false; render(); } }
  }
  async function load(options, attempt) {
    enabled = options.receipts_enabled === true; ai = options.receipt_ai_enabled === true; locked = Boolean(attempt);
    if (!enabled) { render(); return; }
    let draft;
    try { draft = JSON.parse(sessionStorage.getItem(storage) || 'null'); if (draft?.identity !== identity()) draft = null; } catch { draft = null; }
    const id = attempt?.receipt_id || receipt?.id || draft?.id;
    if (!id) { render(); return; }
    receipt = receipt || { id, processing: true };
    const controller = context();
    try {
      const data = await json('/comprovantes/' + id, {}, controller); if (controller.signal.aborted) return;
      receipt = data.receipt;
      if (!attempt && draft?.id === id && draft.fields) {
        fields.forEach(key => { if (typeof draft.fields[key] === 'string') el(key).value = draft.fields[key]; });
        C.financeExpense.setStatus(draft.status || ''); el('mer-confirm').checked = Boolean(draft.confirmed); applied = draft.applied;
      }
      await picture(controller); if (controller.signal.aborted) return;
      apply(receipt); describe(); persist(); poll(controller);
    } catch { if (!controller.signal.aborted) message('Não foi possível recuperar a foto. Toque em Atualizar para tentar novamente.'); }
    finally { if (!controller.signal.aborted) { busy = false; render(); } }
  }
  function payload() {
    if (!receipt) return {};
    if (busy || receipt.processing || receipt.expense_id) throw Error('Confira a situação do comprovante antes de salvar.');
    if (!el('mer-confirm').checked) throw Error('Confirme que conferiu os dados do comprovante.');
    return { receipt_id: receipt.id, receipt_confirmed: true };
  }
  function setLocked(value) {
    locked = value;
    ['mer-camera', 'mer-gallery', 'mer-read', 'mer-remove'].forEach(id => { el(id).disabled = busy || locked; });
  }
  function attachment(body, expenseId) {
    if (!expenseId) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'mf-outline'; button.textContent = 'Ver comprovante';
    button.addEventListener('click', async () => {
      const session = C.sessionFingerprint(); button.disabled = true;
      try {
        const response = await C.authenticatedFetch(base + '/' + expenseId + '/comprovante'); const data = await C.json(response);
        if (session !== C.sessionFingerprint() || !body.isConnected) return;
        if (!response.ok) throw Error('unavailable');
        if (data.receipt) void window.ExpenseReceiptViewer.show(base + '/comprovantes/' + data.receipt.id + '/imagem', C.authenticatedFetch);
        else button.textContent = 'Sem comprovante anexado';
      } catch { if (session === C.sessionFingerprint()) button.textContent = 'Tentar abrir comprovante novamente'; }
      finally { button.disabled = false; }
    }); body.appendChild(button);
  }
  ['camera', 'gallery'].forEach(kind => {
    el('mer-' + kind).addEventListener('click', () => el('mer-' + kind + '-file').click());
    el('mer-' + kind + '-file').addEventListener('change', event => { void upload(event.target.files[0]); event.target.value = ''; });
  });
  el('mer-read').addEventListener('click', () => { if (!busy && !locked) void read(true); });
  el('mer-remove').addEventListener('click', () => { reset(true); C.financeExpense.setStatus('paid'); });
  el('mer-open').addEventListener('click', () => { if (receipt) void window.ExpenseReceiptViewer.show(base + '/comprovantes/' + receipt.id + '/previa', C.authenticatedFetch); });
  el('me-fields').addEventListener('input', event => { if (receipt && !busy && !locked) { if (event.target !== el('mer-confirm')) el('mer-confirm').checked = false; persist(); } });
  document.querySelectorAll('[data-me-status]').forEach(button => button.addEventListener('click', () => { if (receipt) persist(); }));
  C.financeReceipts = { load, reset, cancel, payload, setLocked, attachment, blocked: () => busy || Boolean(receipt?.processing || receipt?.expense_id),
    saved: () => sessionStorage.removeItem(storage) };
}());
