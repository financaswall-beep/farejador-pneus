(function () {
  const loading = document.getElementById('loading');
  const loginForm = document.getElementById('login-form');
  const bootstrapForm = document.getElementById('bootstrap-form');
  const eyebrow = document.getElementById('form-eyebrow');
  const title = document.getElementById('title');
  const subtitle = document.getElementById('form-subtitle');
  const workplaceChooser = document.getElementById('workplace-chooser');
  const workplaceList = document.getElementById('workplace-list');
  const workplaceError = document.getElementById('workplace-error');
  const workplaceBack = document.getElementById('workplace-back');
  let workplaceTicket = null;

  function setButtonBusy(button, busy, busyLabel) {
    const label = button.querySelector('.button-label');
    if (label && !button.dataset.defaultLabel) button.dataset.defaultLabel = label.textContent;
    if (label) label.textContent = busy ? busyLabel : button.dataset.defaultLabel;
    button.disabled = busy;
  }

  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    const input = document.getElementById(button.dataset.passwordToggle);
    if (!input) return;
    button.addEventListener('click', () => {
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      button.setAttribute('aria-pressed', String(!visible));
      button.setAttribute('aria-label', visible ? 'Mostrar senha' : 'Ocultar senha');
      input.focus({ preventScroll: true });
    });
  });

  function show(form) {
    const bootstrap = form === bootstrapForm;
    eyebrow.textContent = bootstrap ? 'Configuração inicial' : 'Acesso à rede';
    title.textContent = bootstrap ? 'Prepare a conta proprietária' : 'Bem-vindo de volta!';
    subtitle.textContent = bootstrap
      ? 'Esta etapa aparece somente antes da criação da primeira conta da Matriz.'
      : 'Entre com seu usuário. O sistema identifica seu local de trabalho.';
    loading.classList.add('hidden');
    loginForm.classList.toggle('hidden', form !== loginForm);
    bootstrapForm.classList.toggle('hidden', form !== bootstrapForm);
    workplaceChooser.classList.add('hidden');
    const firstInput = form.querySelector('input');
    if (firstInput) firstInput.focus({ preventScroll: true });
  }

  function enterSession(payload) {
    if (payload.scope === 'partner') {
      try {
        localStorage.setItem(`farejador_partner_token_${payload.slug}`, payload.session_token);
        sessionStorage.setItem('farejador_panel_workplace', JSON.stringify({
          kind: 'partner', slug: payload.slug, id: payload.workplace.id,
          name: payload.workplace.name,
          modern_panel_enabled: payload.modern_panel_enabled === true,
        }));
      } catch {
        throw new Error('storage_unavailable');
      }
      location.replace(payload.modern_panel_enabled === true
        ? '/admin/painel'
        : `/parceiro/${encodeURIComponent(payload.slug)}/`);
      return;
    }
    sessionStorage.removeItem('farejador_panel_workplace');
    location.replace('/admin/painel');
  }

  function showWorkplaces(payload) {
    workplaceTicket = payload.ticket;
    workplaceList.textContent = '';
    for (const workplace of payload.workplaces || []) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'workplace-option';
      const copy = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = workplace.name;
      const role = document.createElement('small'); role.textContent = workplace.role;
      const kind = document.createElement('span'); kind.className = 'kind';
      kind.textContent = workplace.kind === 'matrix' ? 'Matriz' : 'Parceiro';
      copy.append(name, role); button.append(copy, kind);
      button.addEventListener('click', () => chooseWorkplace(workplace.id, button));
      workplaceList.appendChild(button);
    }
    loginForm.classList.add('hidden'); bootstrapForm.classList.add('hidden');
    loading.classList.add('hidden'); workplaceChooser.classList.remove('hidden');
  }

  async function chooseWorkplace(workplaceId, button) {
    if (!workplaceTicket) return show(loginForm);
    workplaceError.textContent = ''; button.disabled = true;
    try {
      const response = await fetch('/admin/api/auth/login/escolher', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: workplaceTicket, workplace_id: workplaceId }),
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(payload.error || `api_${response.status}`);
      enterSession(payload);
    } catch (failure) {
      workplaceTicket = null; workplaceError.textContent = message(
        failure instanceof Error ? failure.message : 'unknown',
      );
      button.disabled = false;
    }
  }

  function message(error) {
    const labels = {
      invalid_credentials: 'Usuário ou senha inválidos.',
      too_many_attempts: 'Muitas tentativas. Aguarde alguns minutos.',
      invalid_emergency_token: 'O ADMIN_AUTH_TOKEN informado é inválido.',
      username_taken: 'Esse usuário já está em uso. Escolha outro.',
      owner_already_configured: 'A conta proprietária já foi criada. Entre normalmente.',
      ticket_invalid: 'A escolha expirou. Entre novamente.',
    };
    return labels[error] || 'Não foi possível concluir. Tente novamente.';
  }

  async function json(response) {
    return response.json().catch(() => ({}));
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = loginForm.querySelector('button[type="submit"]');
    const error = document.getElementById('login-error');
    setButtonBusy(button, true, 'Entrando…'); error.textContent = '';
    const data = new FormData(loginForm);
    try {
      const response = await fetch('/admin/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(payload.error || `api_${response.status}`);
      if (payload.mode === 'choose') showWorkplaces(payload);
      else enterSession(payload);
    } catch (failure) {
      error.textContent = message(failure instanceof Error ? failure.message : 'unknown');
      setButtonBusy(button, false, 'Entrando…');
    }
  });

  bootstrapForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = bootstrapForm.querySelector('button[type="submit"]');
    const error = document.getElementById('bootstrap-error');
    setButtonBusy(button, true, 'Criando conta…'); error.textContent = '';
    const data = new FormData(bootstrapForm);
    try {
      const response = await fetch('/admin/api/auth/bootstrap', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.get('token')}`,
        },
        body: JSON.stringify({
          display_name: data.get('display_name'),
          username: data.get('username'),
          password: data.get('password'),
        }),
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(payload.error || `api_${response.status}`);
      bootstrapForm.reset();
      location.replace('/admin/painel');
    } catch (failure) {
      error.textContent = message(failure instanceof Error ? failure.message : 'unknown');
      setButtonBusy(button, false, 'Criando conta…');
    }
  });

  async function start() {
    try {
      const me = await fetch('/admin/api/auth/me', { credentials: 'same-origin' });
      if (me.ok) { location.replace('/admin/painel'); return; }
      const status = await fetch('/admin/api/auth/status', { credentials: 'same-origin' });
      const payload = await json(status);
      if (!status.ok) throw new Error('status_failed');
      show(payload.bootstrap_required ? bootstrapForm : loginForm);
    } catch {
      loading.textContent = 'Não consegui verificar o login. Atualize a página em instantes.';
    }
  }

  workplaceBack.addEventListener('click', () => {
    workplaceTicket = null; workplaceError.textContent = ''; show(loginForm);
  });

  void start();
}());
