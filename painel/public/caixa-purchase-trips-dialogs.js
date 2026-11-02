(function () {
  'use strict';
  const C = window.Caixa, P = C.purchases, G = C.purchaseTrips, V = G.view, s = G.state;
  const dialog = V.node('dialog', 'vg-dialog'); dialog.id = 'vg-dialog'; dialog.setAttribute('aria-labelledby', 'vg-dialog-title');
  C.elements.app.append(dialog);
  let origin;
  function show(title) {
    origin = document.activeElement; dialog.replaceChildren();
    const head = V.node('header', 'vg-heading'), close = V.button('', () => { if (!s.busy) dialog.close(); }, false, 'back'); close.setAttribute('aria-label', 'Voltar');
    const h = V.node('h2', '', title); h.id = 'vg-dialog-title'; head.append(close, h);
    const error = V.node('p', 'vg-warning'); error.id = 'vg-dialog-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    dialog.append(head, error); if (!dialog.open) dialog.showModal(); return dialog;
  }
  function fail(error) { const node = G.id('dialog-error'); node.textContent = G.error(error); node.hidden = false; }
  function input(label, value, multiline) {
    const field = V.node('label', 'vg-field', label), control = V.node(multiline ? 'textarea' : 'input'); control.value = value || ''; field.append(control); return { field, control };
  }
  async function create(action, selected) {
    const group = action === 'rename' ? s.detail?.group : null, host = show(group ? 'Editar viagem' : 'Nova viagem');
    const form = V.node('form'), name = input('Nome da viagem', group?.name), notes = input('Observações (opcional)', group?.notes, true);
    name.control.required = true; name.control.minLength = 2; name.control.maxLength = 120; name.control.placeholder = 'Ex.: São Paulo · novembro'; notes.control.maxLength = 2000;
    const save = V.button(group ? 'Salvar viagem' : 'Criar viagem', () => {}, true); save.type = 'submit';
    form.append(name.field, notes.field, save); host.append(form); name.control.focus();
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (s.busy || !form.reportValidity()) return; save.disabled = true;
      try {
        const result = await G.mutate(group ? '/' + group.id + '/acao' : '', { name: name.control.value.trim(), notes: notes.control.value.trim() || null, ...(group ? { action: 'rename' } : {}) });
        dialog.close(); await G.loadOptions();
        if (selected) selected(result); else await G.open(result.id);
      } catch (error) { fail(error); }
      finally { save.disabled = false; }
    });
  }
  async function eligible(page) {
    const group = s.detail?.group; if (!group || group.status !== 'open') return;
    const host = show('Puxar despesa já lançada'); host.append(V.node('p', 'vg-muted', 'Escolha um gasto sem viagem, rota, folha ou comissão.'));
    try {
      const data = await G.api('/elegiveis?page=' + page); if (!dialog.open) return;
      data.rows.forEach(expense => {
        const row = V.card('vg-eligible'), copy = V.node('div'); copy.append(V.node('strong', '', expense.category_label), V.node('p', '', expense.description || P.day(expense.occurred_at)), V.node('b', '', V.money(expense.amount)));
        row.append(copy, V.button('Vincular gasto', () => G.link(group.id, 'expense', expense.id))); host.append(row);
      });
      if (!data.rows.length) host.append(V.node('p', 'vg-empty', 'Nenhuma despesa disponível nesta página.'));
      const nav = V.node('div', 'vg-pagination'), previous = V.button('Anterior', () => eligible(page - 1)), next = V.button('Próxima', () => eligible(page + 1));
      previous.disabled = page === 1; next.disabled = data.rows.length < 50; nav.append(previous, next); host.append(nav);
    } catch (error) { fail(error); }
  }
  function expense(row) {
    const host = show(row.category_label); host.append(V.line('Valor', row.amount), V.node('p', '', row.description || 'Sem descrição'),
      V.node('p', '', P.day(row.occurred_at) + ' · ' + (row.deleted_at ? 'Removida' : row.payment_status === 'paid' ? 'Pago na hora' : 'A pagar')));
    if (row.receipt_id) host.append(V.button('Ver comprovante', () => G.receipt(row), false, 'image'));
    if (s.detail?.group.status === 'open') host.append(V.button('Desvincular gasto', () => G.link(s.detail.group.id, 'expense', row.id, true)));
  }
  function remove() { const host = show('Excluir viagem vazia'); host.append(V.node('p', '', 'Excluir somente a etiqueta desta viagem vazia?'), V.button('Excluir viagem', async () => { await G.action('delete'); if (!s.busy) dialog.close(); }, true)); }
  async function purchaseFields() {
    if (!P.state.draft) return;
    try {
      if (!s.options.length) await G.loadOptions(); if (!P.state.draft) return;
      const value = P.state.draft.group_id || '', control = G.id('purchase-select');
      control.replaceChildren(new Option('Sem viagem', ''));
      s.options.filter(g => g.status === 'open' || g.id === value).forEach(g => { const option = new Option(g.code + ' · ' + g.name + (g.status === 'closed' ? ' (fechada)' : ''), g.id); option.disabled = g.status === 'closed'; control.add(option); });
      control.value = value; control.disabled = Boolean(P.state.pending);
    } catch { G.id('purchase-note').textContent = 'Não foi possível carregar as viagens. Atualize antes de selecionar.'; }
  }
  const field = V.card('vg-purchase-field'); field.append(V.node('h3', '', 'Viagem de compra (opcional)'));
  const select = V.node('select'); select.id = 'vg-purchase-select'; select.setAttribute('aria-label', 'Viagem de compra (opcional)'); field.append(select);
  const note = V.node('p', 'vg-muted'); note.id = 'vg-purchase-note';
  field.append(V.button('Nova viagem', () => { if (!P.state.pending) void create(null, group => { if (P.state.draft) { P.state.draft.group_id = group.id; P.changed(); void purchaseFields(); } }); }, false, 'plus'), note);
  P.id('reference').closest('.pc-card').before(field);
  P.id('wizard').classList.add('vg-purchase-wizard');
  P.id('wizard').querySelectorAll('.pc-steps li').forEach((step, index) => { if (index < 2) { const next = V.icon('next'); next.classList.add('vg-step-next'); step.append(next); } });
  P.id('reference').closest('.pc-card').querySelector('h3').textContent = 'Referência (opcional)';
  const nativeFooter = P.footer;
  P.footer = function (...args) { nativeFooter(...args); if (P.state.draft?.step === 1 && !P.state.busy && !P.state.pending) P.id('continue').textContent = 'Continuar'; };
  select.addEventListener('change', () => { if (P.state.draft && !P.state.pending) { P.state.draft.group_id = select.value; P.changed(); } });
  const nativeStart = P.start;
  P.start = async function (...args) { await nativeStart(...args); await purchaseFields(); };
  const nativeStep = P.renderStep;
  P.renderStep = function (...args) { nativeStep(...args); void purchaseFields(); };
  const nativeOpen = P.openDetail;
  P.openDetail = function (row, receiving) { nativeOpen(row, receiving); if (!receiving) void purchaseLabel(row); };
  async function purchaseLabel(row) {
    const host = V.card('vg-purchase-tag'); P.id('detail').append(host);
    try {
      const data = await G.api('/da-compra/' + row.id); if (!host.isConnected || !P.id('dialog').open) return;
      if (data.group) { host.append(V.node('h3', '', 'Viagem de compra'), V.button(data.group.code + ' · ' + data.group.name, () => G.open(data.group.id)));
        if (data.group.status === 'open') host.append(V.button('Desvincular', async () => { await G.link(data.group.id, 'purchase', row.id, true); P.id('dialog').close(); })); }
      else if (row.status !== 'cancelled') {
        await G.loadOptions(); if (!host.isConnected) return;
        const options = V.node('select'); options.setAttribute('aria-label', 'Vincular compra a uma viagem'); options.append(new Option('Selecione a viagem', ''));
        s.options.filter(g => g.status === 'open').forEach(g => options.add(new Option(g.code + ' · ' + g.name, g.id)));
        host.append(V.node('h3', '', 'Vincular a uma viagem'), options, V.button('Vincular compra', async () => { if (options.value) { await G.link(options.value, 'purchase', row.id, false); P.id('dialog').close(); } }));
      }
    } catch (error) { if (host.isConnected) host.append(V.node('p', 'vg-warning', G.error(error))); }
  }
  dialog.addEventListener('cancel', event => { if (s.busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (origin?.isConnected) origin.focus({ preventScroll: true }); });
  function category(prefill, done) {
    const host = show('Nova modalidade'), form = V.node('form'), name = input('Nome da modalidade', prefill), save = V.button('Salvar modalidade', () => {}, true);
    name.control.required = true; name.control.minLength = 2; name.control.maxLength = 40; save.type = 'submit'; form.append(name.field, save); host.append(form); name.control.focus();
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (s.busy || !form.reportValidity()) return; s.busy = true; save.disabled = true;
      const session = C.sessionFingerprint();
      try {
        const response = await C.authenticatedFetch('/api/caixa/financeiro-despesas/categorias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: name.control.value.trim() }) });
        const data = await C.json(response); if (!response.ok) throw Error(data.error || 'request_failed');
        if (session !== C.sessionFingerprint()) return;
        dialog.close(); done(data);
      } catch (error) { if (session !== C.sessionFingerprint()) return; const message = G.id('dialog-error'); message.hidden = false; message.textContent = error.message === 'category_exists' ? 'Essa modalidade já existe. Escolha a existente na lista.' : 'Não foi possível criar a modalidade. Atualize a lista e confira antes de tentar novamente.'; }
      finally { if (session === C.sessionFingerprint()) { s.busy = false; save.disabled = false; } }
    });
  }
  G.dialogs = { create, eligible, expense, remove, category };
}());
