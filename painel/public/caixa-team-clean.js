(function () {
  'use strict';
  const C = window.Caixa, pages = ['team', 'team-remuneration', 'team-commission', 'team-permissions'];
  const roots = pages.map(name => document.getElementById(name + '-panel'));
  const writes = new Set(); let epoch = 0, fingerprint = '';
  const copy = {
    'team-commission-title': 'Comissão',
    '#team-commission-itemized-rule > h3': 'Por tipo de item',
    '#team-remuneration-form > h3:nth-of-type(2)': 'Benefícios',
    '#team-commission-form > h3': 'Fechamento',
    '.team-permission-intro strong': 'Escolha o que ele pode acessar.',
    '.team-permission-intro span': '',
    '#team-permissions-form > h3:first-of-type': 'Na operação',
  };
  const originalCopy = new Map(Object.keys(copy).map(selector => {
    const el = document.querySelector(selector.startsWith('team-') ? '#' + selector : selector);
    return [selector, { el, text: el.textContent }];
  }));
  const privateIcons = [...document.querySelectorAll('.team-private-note > b,.team-permission-locked > span')].filter(el => el.textContent === '🔒');
  const paths = {
    remuneration: 'M3 5h16v14H3V5Zm0 4h18v7h-6V9m2 3h1',
    commission: 'M4 20V9m5 11V4m6 16v-8m5 8V7',
    lock: 'M6 10h12v11H6V10Zm3 0V6a3 3 0 0 1 6 0v4m-3 5v2',
    vendas: 'M4 9h16v11H4V9Zm3 0V4h10v5M7 13h2m3 0h2m3 0h1M7 16h2m3 0h6',
    estoque: 'm3 7 9-5 9 5-9 5-9-5Zm0 0v10l9 5 9-5V7m-9 5v10M7 4l10 6',
    entregas: 'M2 5h12v13H2V5Zm12 5h5l3 4v4h-8m-9 0a2 2 0 1 0 4 0m8 0a2 2 0 1 0 4 0',
    financeiro: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM15 8H11a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9m3-10v12',
    people: 'M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM1 21v-2a7 7 0 0 1 14 0v2m3-17a4 4 0 0 1 0 8m1 3a6 6 0 0 1 4 6',
  };
  const T = C.teamClean = {
    icon: name => C.createSvg([{ d: paths[name] || paths.people }], 'team-clean-icon'),
    sessionKey: () => C.sessionFingerprint() + '#' + epoch,
    busy: () => writes.size > 0,
  };
  T.request = async (url, options) => {
    if (!C.token() || !C.canModule('team')) throw Error('invalid_session');
    const key = T.sessionKey(), write = options?.method && options.method !== 'GET', operation = {};
    if (write && writes.size) throw Error('team_busy');
    const controls = write ? [...document.querySelectorAll('.team-page:not(.hidden) :is(input,select,button),#team-create-modal:not(.hidden) :is(input,select,button)')].map(el => [el, el.disabled]) : [];
    if (write) { writes.add(operation); controls.forEach(([el]) => { el.disabled = true; }); }
    try {
      const response = await C.authenticatedFetch(url, options), data = await C.json(response);
      if (key !== T.sessionKey() || !C.canModule('team')) throw Error('invalid_session');
      return { response, data };
    } finally {
      writes.delete(operation);
      if (key === T.sessionKey()) controls.forEach(([el, disabled]) => { el.disabled = disabled; });
    }
  };
  T.blockNavigation = () => {
    if (C.isPartner() || !writes.size) return false;
    C.showToast('Aguarde a confirmação do salvamento.'); return true;
  };
  T.reset = () => {
    epoch++; fingerprint = ''; writes.clear();
    C.teamState?.request?.abort();
    if (C.teamState) Object.assign(C.teamState, { payload: null, memberId: '', filter: 'all', search: '', showInactive: false, request: null });
    C.closeNewMember?.();
    document.querySelectorAll('#team-create-modal :is(input,select,button)').forEach(el => { el.disabled = false; });
    roots.forEach(root => {
      root.querySelectorAll('input').forEach(input => { if (['checkbox', 'radio'].includes(input.type)) input.checked = false; else input.value = ''; });
      root.querySelectorAll('.team-person strong,.team-person em,.team-person div > span').forEach(el => { el.textContent = ''; });
      root.querySelectorAll('button,input,select').forEach(el => { el.disabled = false; });
      root.querySelectorAll('.team-save-error').forEach(el => { el.textContent = ''; });
      root.querySelectorAll('.team-detail-content,#team-content').forEach(el => el.classList.add('hidden'));
    });
    ['team-list', 'team-benefits', 'team-commission-history'].forEach(id => document.getElementById(id).replaceChildren());
    document.getElementById('team-search').value = '';
    document.querySelectorAll('[data-team-filter]').forEach(button => { const active = button.dataset.teamFilter === 'all'; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  };
  T.refresh = () => {
    if (C.isPartner()) return;
    const date = document.getElementById('team-compensation-start').value;
    document.querySelector('.team-fixed-summary').classList.toggle('is-weekly', document.querySelector('input[name="team-salary-frequency"]:checked')?.value === 'weekly');
    document.getElementById('team-payment-preview').textContent = date ? 'Válida a partir de ' + date.split('-').reverse().join('/') : 'Dia do pagamento e início da vigência';
    roots.forEach(root => root.querySelectorAll('.team-person').forEach(person => { person.classList.toggle('is-inactive', person.querySelector('em')?.textContent === 'Inativo'); }));
  };
  T.sync = tab => {
    if (fingerprint !== C.sessionFingerprint()) { T.reset(); fingerprint = C.sessionFingerprint(); }
    const matrix = !C.isPartner(), details = document.getElementById('team-payment-details');
    originalCopy.forEach(({ el, text }, selector) => { el.textContent = matrix ? copy[selector] : text; });
    privateIcons.forEach(el => { if (matrix) el.replaceChildren(T.icon('lock')); else el.textContent = '🔒'; });
    if (!matrix) details.open = true;
    else if (details.dataset.session !== T.sessionKey()) { details.open = false; details.dataset.session = T.sessionKey(); }
    if (!matrix || !pages.includes(tab)) return;
    T.refresh();
    if (!writes.size) roots.filter(root => !root.classList.contains('hidden')).forEach(root => { root.scrollTop = 0; });
  };
  document.getElementById('team-compensation-start').addEventListener('input', T.refresh);
  document.getElementById('team-payment-details').addEventListener('invalid', () => { document.getElementById('team-payment-details').open = true; }, true);
  document.addEventListener('click', event => {
    if (C.isPartner() || !writes.size) return;
    if (event.target.closest('.bottom-nav button,#notifications-button,#operator-button,[data-close-team-create]')) {
      event.preventDefault(); event.stopImmediatePropagation(); T.blockNavigation();
    }
  }, true);
  window.addEventListener('beforeunload', event => { if (writes.size) { event.preventDefault(); event.returnValue = ''; } });
}());
