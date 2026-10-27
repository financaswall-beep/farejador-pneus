(function () {
  'use strict';
  const C = window.Caixa, V = C.financeView, el = id => document.getElementById(id);
  const panel = el('matrix-finance-panel'), content = el('mfc-content'), app = C.elements.app;
  const dialogs = new Map();
  let engaged = false;
  const active = () => Boolean(C.token() && !C.isPartner() && app.classList.contains('is-matrix-finance-clean'));
  const busy = () => Boolean(C.financePayment?.busy() || C.financeExpense?.busy() || C.financeCommissionMonth?.busy() || C.financeReceipts?.working());
  function blockNavigation() {
    if (!active() || !busy()) return false;
    C.showToast('Aguarde a confirmação da operação.'); return true;
  }
  function updateDialogs() {
    const open = Array.from(dialogs.keys()).filter(d => d.open);
    content.inert = active() && open.length > 0;
    open.forEach((dialog, index) => { dialog.inert = index !== open.length - 1; dialog.style.zIndex = String(70 + index); });
  }
  function showDialog(dialog) {
    if (!active()) { if (!dialog.open) dialog.showModal(); return; }
    if (!dialogs.has(dialog)) {
      panel.appendChild(dialog); dialog.classList.add('mfc-sheet'); dialog.setAttribute('aria-modal', 'false');
      dialogs.set(dialog, null);
      dialog.addEventListener('close', () => {
        const origin = dialogs.get(dialog); updateDialogs();
        if (active() && origin?.isConnected && !origin.closest('[inert]')) origin.focus({ preventScroll: true });
        dialogs.set(dialog, null);
        if (dialog.classList.contains('mfc-receipt-viewer')) dialogs.delete(dialog);
      });
    }
    if (!dialog.open) {
      dialogs.set(dialog, document.activeElement); dialog.show(); updateDialogs();
      dialog.querySelector('header button,button,input,select')?.focus({ preventScroll: true });
    }
  }
  function closeDialogs() {
    Array.from(dialogs.keys()).reverse().forEach(dialog => { dialog.inert = false; dialog.close(); });
    window.ExpenseReceiptViewer?.close(); content.inert = false;
  }
  function sync(value) {
    if (engaged && !value) closeDialogs();
    engaged = value;
  }
  function view(tab) {
    closeDialogs(); panel.dataset.financeView = tab;
    panel.scrollTop = 0;
    el('mfc-position').classList.toggle('hidden', tab !== 'accounts');
    if (tab === 'accounts') el('mf-month').closest('label').classList.add('hidden');
  }
  function summary(payload) {
    const badge = el('mfc-today-count'), amount = el('mfc-today-amount'), names = el('mfc-today-names');
    try {
      // A agenda publicada é a posição completa em aberto, sem recorte pelo mês do resumo.
      const group = payload.agenda?.a_pagar;
      if (!group || !Array.isArray(group.itens)) throw Error('missing_agenda');
      const today = window.FarejadorTime.dateKey(new Date());
      const rows = group.itens.filter(row => row.due_date === today);
      const cents = rows.reduce((total, row) => total + Math.round(V.number(row.valor) * 100), 0);
      badge.textContent = rows.length + (rows.length === 1 ? ' conta' : ' contas');
      V.amount(amount, V.money(cents / 100));
      names.textContent = rows.length ? rows.slice(0, 2).map(row => row.nome).join(' e ') + (rows.length > 2 ? ' e mais ' + (rows.length - 2) : '') : 'Nenhuma conta vence hoje.';
      el('mfc-today-open').textContent = rows.length ? 'Ver contas de hoje' : 'Ver contas a pagar';
      el('mfc-today-open').dataset.today = String(rows.length > 0);
      el('mfc-today').classList.toggle('is-empty', !rows.length);
    } catch {
      badge.textContent = 'Indisponível'; V.amount(amount, '—'); names.textContent = 'Atualize para conferir os vencimentos.';
      el('mfc-today-open').textContent = 'Conferir contas'; el('mfc-today-open').dataset.today = 'false';
    }
  }
  function accounts(payload, state, rows, statement) {
    const settled = state.status === 'settled';
    el('mf-month').closest('label').classList.toggle('hidden', !settled);
    el('mfc-position').classList.toggle('hidden', settled);
    if (!payload) return;
    const outgoing = state.direction === 'out';
    document.querySelectorAll('.ma-segment [data-ma-direction]').forEach(button => {
      const group = payload.agenda[button.dataset.maDirection === 'out' ? 'a_pagar' : 'a_receber'];
      button.textContent = (button.dataset.maDirection === 'out' ? 'A pagar' : 'A receber') + ' · ' + group.itens.length;
    });
    const filtered = !settled && Boolean(state.today || state.search || state.category !== 'all' || state.status === 'overdue');
    el('mfc-accounts-label').textContent = settled ? (outgoing ? 'Pagamentos do mês' : 'Recebimentos do mês') : filtered ? 'Total da seleção' : outgoing ? 'Total a pagar' : 'Total a receber';
    const total = settled ? statement?.summary?.[outgoing ? 'outgoing' : 'incoming']
      : filtered ? rows.reduce((sum, row) => sum + Math.round(V.number(row.valor) * 100), 0) / 100
        : payload.agenda[outgoing ? 'a_pagar' : 'a_receber'].total;
    V.amount('mfc-accounts-total', total == null ? '—' : V.money(total));
    el('mfc-today-filter').classList.toggle('hidden', !state.today);
  }
  function reset() {
    engaged = false; closeDialogs();
    el('mfc-more').open = false;
    el('mfc-today-count').textContent = ''; el('mfc-today-names').textContent = '';
    V.amount('mfc-today-amount', '—'); V.amount('mfc-accounts-total', '—');
  }
  el('mfc-today-open').addEventListener('click', () => {
    C.financeAccounts.showOpen(el('mfc-today-open').dataset.today === 'true');
  });
  el('mfc-today-clear').addEventListener('click', () => C.financeAccounts.showOpen(false));
  // Os filtros secundários continuam disponíveis sem ocupar o primeiro nível da tela.
  el('ma-filter-panel').appendChild(document.querySelector('[data-ma-status]').parentElement);
  el('ma-filter-panel').appendChild(el('ma-scope'));
  ['mf-detail', 'mer-summary'].forEach(id => {
    const dialog = el(id); panel.appendChild(dialog);
    dialog.addEventListener('cancel', event => { if (active()) { event.preventDefault(); if (!blockNavigation()) dialog.close(); } });
  });
  document.addEventListener('click', event => {
    if (!active() || !busy() || !event.target.closest('#mf-detail-close,#mf-detail-done,#mer-summary-close,#mer-summary-done')) return;
    event.preventDefault(); event.stopImmediatePropagation(); blockNavigation();
  }, true);
  document.addEventListener('keydown', event => {
    if (!active() || event.key !== 'Escape') return;
    const top = Array.from(dialogs.keys()).filter(dialog => dialog.open).at(-1);
    if (!top) return;
    event.preventDefault(); if (!blockNavigation()) top.close();
  });
  C.financeClean = { active, blockNavigation, sync, view, summary, accounts, showDialog, reset };
}());
