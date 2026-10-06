(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  const S = () => C.partnerStore;
  const F = () => C.partnerStoreForm;
  let rows = [];
  let request = 0;
  const modules = [
    ['vendas', 'Vendas e pedidos de foto'], ['estoque', 'Meus pneus'], ['retiradas', 'Retiradas'],
    ['entregas', 'Entregas'], ['financeiro', 'Financeiro'], ['pedidos', 'Consulta de pedidos'],
    ['clientes', 'Clientes'], ['batepapo', 'Bate-papo'], ['resumo', 'Resumo'],
    ['compras', 'Compras'], ['colaboradores', 'Consulta da equipe'], ['catalogo', 'Catálogo'],
  ];
  const name = row => row.label || row.username || 'Funcionário';
  const path = row => 'funcionarios/' + encodeURIComponent(row.id);
  function notice(page) { const el = U.node('p', null, 'ps-error'); el.setAttribute('role', 'alert'); page.appendChild(el); return el; }
  function card(row) {
    const el = S().plate('button'); el.type = 'button'; el.classList.add('ps-team-card');
    el.setAttribute('aria-label', name(row));
    const avatar = U.node('span', name(row).trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase(), 'ps-team-avatar');
    const copy = U.node('span', null, 'ps-store-copy');
    copy.append(U.node('strong', name(row)), U.node('span', 'Login: ' + (row.username || 'Não definido')));
    const status = U.node('span', row.revoked_at ? 'Inativo' : 'Ativo', 'ps-team-status'); status.dataset.active = String(!row.revoked_at);
    const head = U.node('span', null, 'ps-team-head'); head.append(avatar, copy, status);
    const footer = U.node('span', null, 'ps-team-footer'); footer.append(U.node('span', 'Ajustar acesso'), S().icon('arrow'));
    el.append(head, footer); el.addEventListener('click', () => detail(row)); return el;
  }
  function list(error) {
    if (!S().owner()) return;
    if (typeof error !== 'string') error = '';
    const page = S().screen('Funcionários', S().back);
    page.appendChild(U.node('p', rows.length + (rows.length === 1 ? ' funcionário cadastrado' : ' funcionários cadastrados'), 'ps-store-help'));
    page.appendChild(S().action('+ ADICIONAR FUNCIONÁRIO', create));
    page.appendChild(U.node('h4', 'Sua equipe', 'ps-team-title'));
    const group = U.node('div', null, 'ps-store-menu'); rows.forEach(row => group.appendChild(card(row))); page.appendChild(group);
    if (error) { page.appendChild(U.node('p', error, 'ps-error')); page.appendChild(S().action('TENTAR DE NOVO', open)); }
    else if (!rows.length) page.appendChild(U.node('p', 'Adicione quem trabalha com você.', 'ps-store-help'));
    page.appendChild(U.node('p', 'Você escolhe o acesso de cada um.', 'ps-store-help'));
    S().show('team', page);
  }
  async function open() {
    if (!S().owner() || S().busy()) return;
    const version = S().generation(); const session = C.sessionFingerprint(); const current = ++request;
    const page = S().screen('Funcionários', S().back); page.appendChild(U.node('p', 'Carregando sua equipe…', 'ps-store-help'));
    S().show('team', page);
    try {
      const data = await C.partnerData.api('funcionarios');
      if (version !== S().generation() || session !== C.sessionFingerprint() || current !== request) return;
      rows = data.rows || []; list();
    } catch (_) {
      if (version === S().generation() && session === C.sessionFingerprint() && current === request) list('Não consegui carregar sua equipe.');
    }
  }
  function create() {
    if (!S().owner()) return;
    request += 1;
    const { page, form, content, notice: error } = F().setup('Adicionar funcionário', list);
    const label = F().field(content, 'Nome', 'text', ''); label.required = true; label.maxLength = 120; label.autocomplete = 'off';
    const username = F().field(content, 'Login', 'text', ''); username.required = true; username.minLength = 3; username.maxLength = 60;
    username.pattern = '[a-zA-Z0-9._-]+'; username.autocomplete = 'off'; username.autocapitalize = 'none'; username.spellcheck = false;
    const password = F().field(content, 'Senha', 'password', ''); password.required = true; password.minLength = 12; password.maxLength = 200; password.autocomplete = 'new-password';
    content.appendChild(U.node('p', 'Senha com pelo menos 12 caracteres.', 'ps-store-help'));
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      if (!label.value.trim() || !/^[a-zA-Z0-9._-]{3,60}$/.test(username.value.trim()) || password.value.length < 12) {
        error.textContent = 'Preencha nome, login e uma senha com pelo menos 12 caracteres.'; return;
      }
      void S().run(page, () => C.partnerData.api('funcionarios', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.value.trim(), username: username.value.trim(), password: password.value }),
      }), async result => {
        password.value = ''; const row = { ...result, revoked_at: null }; rows.unshift(row);
        C.showToast('Funcionário criado. Escolha os acessos.'); await detail(row);
      }, error);
    });
    S().show('team-create', page);
  }
  async function detail(row) {
    if (!S().owner() || S().busy()) return;
    const current = ++request; const version = S().generation(); const session = C.sessionFingerprint();
    if (row.revoked_at) { inactive(row); return; }
    const page = S().screen('Acesso do funcionário', () => { request += 1; list(); });
    page.appendChild(U.node('h4', name(row))); const error = notice(page);
    const loading = U.node('p', 'Carregando acessos…', 'ps-store-help'); page.appendChild(loading); S().show('team-detail', page);
    try {
      const data = await C.partnerData.api(path(row) + '/config');
      if (current !== request || version !== S().generation() || session !== C.sessionFingerprint()) return;
      loading.remove();
      const form = U.node('form'); const content = S().plate(); content.classList.add('ps-store-fields');
      content.appendChild(U.node('p', 'O que ele pode acessar?', 'ps-store-help'));
      const fields = modules.map(([key, title]) => [key, F().toggle(content, title, data.permissions?.[key] === true)]);
      const save = S().action('SALVAR ACESSOS', () => {}, 'primary', 'check'); save.type = 'submit';
      form.append(content, save); page.appendChild(form);
      form.addEventListener('submit', event => {
        event.preventDefault();
        void S().run(page, () => C.partnerData.api(path(row) + '/permissoes', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(fields.map(([key, input]) => [key, input.checked]))),
        }), () => { C.showToast('Acessos salvos.'); list(); }, error);
      });
      page.appendChild(S().action('REDEFINIR SENHA', () => resetPassword(row), 'secondary'));
      page.appendChild(S().action('DESATIVAR ACESSO', () => confirmDeactivate(row), 'secondary'));
    } catch (_) {
      if (current === request && version === S().generation() && session === C.sessionFingerprint()) {
        error.textContent = 'Não consegui carregar os acessos.'; page.appendChild(S().action('TENTAR DE NOVO', () => detail(row)));
      }
    }
  }
  function resetPassword(row) {
    const { page, form, content, notice: error } = F().setup('Redefinir senha', () => detail(row));
    content.appendChild(U.node('strong', name(row)));
    const password = F().field(content, 'Nova senha', 'password', ''); password.required = true;
    password.minLength = 12; password.maxLength = 200; password.autocomplete = 'new-password';
    content.appendChild(U.node('p', 'Mínimo de 12 caracteres. As sessões antigas serão encerradas.', 'ps-store-help'));
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      void S().run(page, () => C.partnerData.api(path(row) + '/reset-senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value }) }),
        () => { password.value = ''; C.showToast('Senha redefinida.'); list(); }, error);
    });
    S().show('team-password', page);
  }
  function confirmDeactivate(row) {
    const page = S().screen('Desativar acesso?', () => detail(row));
    page.appendChild(U.node('p', name(row) + ' não poderá entrar. O histórico será preservado.', 'ps-store-help'));
    const error = notice(page);
    page.appendChild(S().action('SIM, DESATIVAR', () => S().run(page, () => C.partnerData.api(path(row), { method: 'DELETE' }),
      async () => { C.showToast('Acesso desativado.'); await open(); }, error), 'secondary'));
    page.appendChild(S().action('MANTER ACESSO', () => detail(row)));
    S().show('team-confirm', page);
  }
  function inactive(row) {
    const page = S().screen('Funcionário inativo', list);
    page.appendChild(U.node('h4', name(row))); page.appendChild(U.node('p', 'Login: ' + (row.username || 'Não definido'), 'ps-store-help'));
    const error = notice(page);
    page.appendChild(S().action('REATIVAR ACESSO', () => S().run(page, () => C.partnerData.api(path(row) + '/reativar', { method: 'POST' }),
      async () => { C.showToast('Acesso reativado.'); await open(); }, error)));
    S().show('team-inactive', page);
  }
  C.partnerTeam = { open, reset: () => { request += 1; rows = []; } };
}());
