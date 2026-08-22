(function () {
  'use strict';

  const Caixa = window.Caixa;
  const state = Caixa.teamState;
  let payload = null;

  const definitions = {
    vendas: ['Caixa', 'Frente de caixa, catálogo e as próprias vendas', 'C'],
    estoque: ['Estoque', 'Consultar produtos, fazer contagem e recebimento', 'E'],
    entregas: ['Entregas', 'Ver pedidos, rotas e registrar a entrega', 'R'],
    pedidos: ['Pedidos', 'Consultar e acompanhar pedidos da unidade', 'P'],
    clientes: ['Clientes', 'Consultar e cadastrar clientes', 'C'],
    retiradas: ['Retiradas', 'Organizar pedidos para retirada no balcão', 'T'],
    resumo: ['Resumo da loja', 'Visualizar os indicadores gerais da unidade', 'S'],
    financeiro: ['Financeiro', 'Ver entradas, saídas, pendências e comissões', '$'],
  };
  const groups = {
    operation: ['vendas', 'estoque', 'entregas'],
    portal: ['pedidos', 'clientes', 'retiradas', 'resumo'],
    management: ['financeiro'],
  };

  function memberId() {
    const match = window.location.hash.match(/^#equipe\/permissoes\/([^/]+)$/);
    if (match) state.memberId = decodeURIComponent(match[1]);
    return state.memberId || '';
  }
  function url() { return Caixa.teamPath(memberId()) + '/permissoes'; }
  function initials(name) {
    const words = String(name || 'Colaborador').trim().split(/\s+/);
    return (((words[0] && words[0][0]) || 'C') + ((words[1] && words[1][0]) || (words[0] && words[0][1]) || 'O')).toUpperCase();
  }
  function setMode(mode) {
    document.getElementById('team-permissions-loading').classList.toggle('hidden', mode !== 'loading');
    document.getElementById('team-permissions-error').classList.toggle('hidden', mode !== 'error');
    document.getElementById('team-permissions-form').classList.toggle('hidden', mode !== 'content');
  }

  function row(key) {
    const info = definitions[key];
    const label = document.createElement('label'); label.className = 'team-permission-row';
    const icon = document.createElement('b'); icon.textContent = info[2];
    const copy = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = info[0];
    const detail = document.createElement('small'); detail.textContent = info[1];
    copy.append(title, detail);
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.permission = key;
    input.checked = payload.permissions[key] === true; input.disabled = payload.locked;
    const toggle = document.createElement('i'); toggle.setAttribute('aria-hidden', 'true');
    label.append(icon, copy, input, toggle); return label;
  }

  function renderGroup(id, keys) {
    const container = document.getElementById(id); container.replaceChildren();
    const available = new Set(payload.available_permissions || []);
    keys.filter(function (key) { return available.has(key); })
      .forEach(function (key) { container.appendChild(row(key)); });
    return container.childElementCount;
  }

  function render(data) {
    payload = data; const person = data.member;
    document.getElementById('team-permissions-unit').textContent = data.unit_name;
    document.getElementById('team-permissions-avatar').textContent = initials(person.name);
    document.getElementById('team-permissions-name').textContent = person.name;
    document.getElementById('team-permissions-role').textContent = person.role;
    document.getElementById('team-permissions-status').textContent = person.active ? 'Ativo' : 'Inativo';
    renderGroup('team-permissions-operation', groups.operation);
    const portalCount = renderGroup('team-permissions-portal', groups.portal);
    document.getElementById('team-permissions-portal-section').classList.toggle('hidden', portalCount === 0);
    renderGroup('team-permissions-management', groups.management);
    const save = document.getElementById('team-permissions-save'); save.disabled = data.locked;
    save.textContent = data.locked ? 'Permissões protegidas' : 'Salvar permissões';
    document.getElementById('team-permissions-note').lastChild.textContent = data.locked
      ? 'O acesso do proprietário ou de um colaborador inativo não pode ser alterado nesta tela.'
      : 'Ao alterar permissões, as sessões atuais deste colaborador serão encerradas por segurança.';
    document.getElementById('team-permissions-save-error').textContent = '';
  }

  async function load(force) {
    if (!memberId()) return back();
    if (payload && !force && payload.member.id === memberId()) { render(payload); setMode('content'); return; }
    setMode('loading');
    try {
      const response = await Caixa.authenticatedFetch(url());
      const data = await Caixa.json(response); if (!response.ok) throw new Error(data.error || 'request_failed');
      render(data); setMode('content');
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_session') return;
      setMode('error');
    }
  }

  async function save(event) {
    event.preventDefault(); if (!payload || payload.locked) return;
    const body = {};
    document.querySelectorAll('[data-permission]').forEach(function (input) {
      body[input.dataset.permission] = input.checked;
    });
    const button = document.getElementById('team-permissions-save');
    const error = document.getElementById('team-permissions-save-error');
    error.textContent = ''; button.disabled = true; button.textContent = 'Salvando…';
    try {
      const response = await Caixa.authenticatedFetch(url(), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await Caixa.json(response); if (!response.ok) throw new Error(data.error || 'request_failed');
      render(data); Caixa.teamState.payload = null;
      Caixa.showToast('Permissões salvas. O colaborador entrará novamente com o novo acesso.');
    } catch (failure) {
      error.textContent = failure instanceof Error && failure.message === 'owner_permissions_locked'
        ? 'O acesso do proprietário é protegido.' : 'Não foi possível salvar. Tente novamente.';
    } finally {
      button.disabled = Boolean(payload && payload.locked);
      button.textContent = payload && payload.locked ? 'Permissões protegidas' : 'Salvar permissões';
    }
  }

  function back() { window.location.hash = '#equipe'; Caixa.showTab('team'); }

  Object.assign(Caixa, { loadTeamPermissions: load });
  document.getElementById('team-permissions-form').addEventListener('submit', save);
  document.getElementById('team-permissions-retry').addEventListener('click', function () { void load(true); });
  document.getElementById('team-permissions-back').addEventListener('click', back);
}());
