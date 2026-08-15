(function () {
  'use strict';

  const Caixa = window.Caixa;
  const state = Caixa.teamState = Caixa.teamState || {
    payload: null, memberId: '', filter: 'all', search: '', showInactive: false, request: null,
  };

  function path(suffix) {
    const base = Caixa.operationPath('equipe', '/api/caixa/equipe');
    return suffix ? base + '/' + encodeURIComponent(suffix) : base;
  }

  function initials(name) {
    const words = String(name || 'Colaborador').trim().split(/\s+/).filter(Boolean);
    return ((words[0] && words[0][0]) || 'C') + ((words[1] && words[1][0]) || (words[0] && words[0][1]) || 'O');
  }

  function setState(mode) {
    document.getElementById('team-loading').classList.toggle('hidden', mode !== 'loading');
    document.getElementById('team-error').classList.toggle('hidden', mode !== 'error');
    document.getElementById('team-content').classList.toggle('hidden', mode !== 'content');
  }

  function action(label, className, click) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = className; button.textContent = label;
    button.addEventListener('click', click); return button;
  }

  function openMember(member, section) {
    state.memberId = member.id;
    window.location.hash = '#equipe/' + section + '/' + encodeURIComponent(member.id);
    const tabs = { remuneracao: 'team-remuneration', comissao: 'team-commission', permissoes: 'team-permissions' };
    Caixa.showTab(tabs[section] || 'team');
  }

  function memberCard(member) {
    const article = document.createElement('article'); article.className = 'team-member-card';
    if (!member.active) article.classList.add('is-inactive');
    const head = document.createElement('div'); head.className = 'team-member-head';
    const avatar = document.createElement('b'); avatar.className = 'team-avatar';
    avatar.textContent = initials(member.name).toUpperCase();
    const identity = document.createElement('p');
    const name = document.createElement('strong'); name.textContent = member.name;
    const role = document.createElement('span'); role.textContent = member.role + ' · ';
    const status = document.createElement('em'); status.textContent = member.active ? 'Ativo' : 'Inativo';
    role.appendChild(status); identity.append(name, role); head.append(avatar, identity);

    const metrics = document.createElement('div'); metrics.className = 'team-member-metrics';
    const salary = document.createElement('p'); salary.innerHTML = '<small>Salário</small>';
    const salaryValue = document.createElement('strong');
    salaryValue.textContent = member.base_salary > 0 ? Caixa.currency.format(member.base_salary) : 'Não configurado';
    salary.appendChild(salaryValue);
    const commission = document.createElement('p'); commission.innerHTML = '<small>Comissão</small>';
    const commissionValue = document.createElement('strong');
    commissionValue.textContent = !member.commission_active ? 'Sem comissão'
      : member.commission_kind === 'percent' ? Caixa.currency.format(member.commission_value).replace('R$', '').trim() + '%'
        : Caixa.currency.format(member.commission_value) + ' fixa';
    commission.appendChild(commissionValue); metrics.append(salary, commission);

    const buttons = document.createElement('div'); buttons.className = 'team-member-actions';
    buttons.append(
      action('▤  Remuneração', 'team-outline', function () { openMember(member, 'remuneracao'); }),
      action('%  Comissão', 'team-outline', function () { openMember(member, 'comissao'); }),
      action('✓  Permissões', 'team-outline team-permission-action', function () { openMember(member, 'permissoes'); }),
    );
    article.append(head, metrics, buttons); return article;
  }

  function visibleMembers() {
    const members = (state.payload && state.payload.members) || [];
    const query = state.search.trim().toLocaleLowerCase('pt-BR');
    return members.filter(function (member) {
      if (member.active === state.showInactive) return false;
      if (state.filter !== 'all' && member.work_area !== state.filter) return false;
      return !query || [member.name, member.username, member.role].some(function (value) {
        return String(value || '').toLocaleLowerCase('pt-BR').includes(query);
      });
    });
  }

  function render() {
    const payload = state.payload; if (!payload) return;
    document.getElementById('team-unit').textContent = payload.unit_name;
    document.getElementById('team-active-count').textContent = payload.active_count + (payload.active_count === 1 ? ' colaborador' : ' colaboradores');
    document.getElementById('team-commission-total').textContent = Caixa.currency.format(payload.commission_total || 0);
    const list = document.getElementById('team-list'); list.replaceChildren();
    const inactiveCount = payload.members.filter(function (member) { return !member.active; }).length;
    const inactiveToggle = document.getElementById('team-inactive-toggle');
    inactiveToggle.classList.toggle('hidden', inactiveCount === 0);
    inactiveToggle.textContent = state.showInactive
      ? 'Voltar para equipe ativa'
      : 'Ver desativados (' + inactiveCount + ')';
    document.getElementById('team-list-title').textContent = state.showInactive
      ? 'Colaboradores desativados'
      : 'Minha equipe';
    const members = visibleMembers();
    if (!members.length) {
      const empty = document.createElement('p'); empty.className = 'team-empty';
      empty.textContent = state.showInactive
        ? 'Nenhum colaborador desativado encontrado.'
        : 'Nenhum colaborador ativo encontrado.';
      list.appendChild(empty); return;
    }
    members.forEach(function (member) { list.appendChild(memberCard(member)); });
  }

  async function loadTeam(force) {
    if (!Caixa.canModule('team')) return;
    if (state.payload && !force) { render(); setState('content'); return; }
    if (state.request) state.request.abort(); state.request = new AbortController(); setState('loading');
    try {
      const response = await Caixa.authenticatedFetch(path(), { signal: state.request.signal });
      const payload = await Caixa.json(response); if (!response.ok) throw new Error(payload.error || 'request_failed');
      state.payload = payload; render(); setState('content');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof Error && error.message === 'invalid_session') return;
      setState('error');
    } finally { state.request = null; }
  }

  function configureNewMemberRoles() {
    const select = document.getElementById('team-create-role');
    const roles = Caixa.isPartner()
      ? [['vendedor', 'Vendedor'], ['estoque', 'Estoque'], ['entregador', 'Entregador']]
      : [['vendedor', 'Vendedor'], ['entregador', 'Entregador'], ['administrativo', 'Administrativo']];
    select.replaceChildren();
    roles.forEach(function (role) {
      const option = document.createElement('option');
      option.value = role[0]; option.textContent = role[1]; select.appendChild(option);
    });
  }

  function closeNewMember() {
    document.getElementById('team-create-modal').classList.add('hidden');
    document.getElementById('team-create-form').reset();
    document.getElementById('team-create-error').textContent = '';
  }

  function openNewMember() {
    configureNewMemberRoles();
    document.getElementById('team-create-form').reset();
    document.getElementById('team-create-error').textContent = '';
    document.getElementById('team-create-modal').classList.remove('hidden');
    document.getElementById('team-create-name').focus({ preventScroll: true });
  }

  function newMemberError(code) {
    if (code === 'username_taken') return 'Este usuário já está sendo usado. Escolha outro.';
    if (code === 'usuario_invalido') return 'Use somente letras, números, ponto, traço ou sublinhado no usuário.';
    if (code === 'owner_required') return 'Somente o proprietário pode criar colaboradores.';
    return 'Não foi possível criar o colaborador. Confira os campos e tente novamente.';
  }

  async function submitNewMember(event) {
    event.preventDefault();
    const error = document.getElementById('team-create-error');
    const submit = document.getElementById('team-create-submit');
    const name = document.getElementById('team-create-name').value.trim();
    const username = document.getElementById('team-create-username').value.trim().toLowerCase();
    const password = document.getElementById('team-create-password').value;
    const confirmation = document.getElementById('team-create-confirm').value;
    const role = document.getElementById('team-create-role').value;
    error.textContent = '';
    if (name.length < 2 || !/^[a-zA-Z0-9._-]{3,60}$/.test(username)) {
      error.textContent = 'Informe o nome e um usuário válido com pelo menos 3 caracteres.'; return;
    }
    if (password.length < 12) {
      error.textContent = 'A senha provisória precisa ter pelo menos 12 caracteres.'; return;
    }
    if (password !== confirmation) {
      error.textContent = 'A confirmação não corresponde à senha provisória.'; return;
    }
    submit.disabled = true; submit.textContent = 'CRIANDO…';
    try {
      const response = await Caixa.authenticatedFetch(path(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, username: username, password: password, role: role }),
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      closeNewMember(); state.payload = null; state.showInactive = false; await loadTeam(true);
      Caixa.showToast('Colaborador criado. Agora confira as permissões de acesso.');
      const member = state.payload && state.payload.members.find(function (item) { return item.id === payload.id; });
      if (member) openMember(member, 'permissoes');
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      error.textContent = newMemberError(failure instanceof Error ? failure.message : 'request_failed');
    } finally {
      submit.disabled = false; submit.textContent = 'Criar colaborador';
    }
  }

  Object.assign(Caixa, { teamPath: path, loadTeam: loadTeam, closeNewMember: closeNewMember });
  document.getElementById('team-retry').addEventListener('click', function () { void loadTeam(true); });
  document.getElementById('team-search').addEventListener('input', function (event) {
    state.search = event.target.value; render();
  });
  document.getElementById('team-filters').addEventListener('click', function (event) {
    const button = event.target.closest('[data-team-filter]'); if (!button) return;
    state.filter = button.dataset.teamFilter;
    document.querySelectorAll('[data-team-filter]').forEach(function (item) { item.classList.toggle('active', item === button); });
    render();
  });
  document.getElementById('team-new-member').addEventListener('click', openNewMember);
  document.getElementById('team-inactive-toggle').addEventListener('click', function () {
    state.showInactive = !state.showInactive;
    render();
  });
  document.querySelectorAll('[data-close-team-create]').forEach(function (button) {
    button.addEventListener('click', closeNewMember);
  });
  document.getElementById('team-create-form').addEventListener('submit', function (event) {
    void submitNewMember(event);
  });
}());
