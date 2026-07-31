(function () {
  const loading = document.getElementById('loading');
  const loginForm = document.getElementById('login-form');
  const bootstrapForm = document.getElementById('bootstrap-form');
  const eyebrow = document.getElementById('form-eyebrow');
  const title = document.getElementById('title');
  const subtitle = document.getElementById('form-subtitle');

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
    eyebrow.textContent = bootstrap ? 'Configuração inicial' : 'Acesso à Matriz';
    title.textContent = bootstrap ? 'Prepare a conta proprietária' : 'Bem-vindo de volta!';
    subtitle.textContent = bootstrap
      ? 'Esta etapa aparece somente antes da criação da primeira conta da Matriz.'
      : 'Entre com seu usuário para acessar a gestão da 2W Pneus.';
    loading.classList.add('hidden');
    loginForm.classList.toggle('hidden', form !== loginForm);
    bootstrapForm.classList.toggle('hidden', form !== bootstrapForm);
    const firstInput = form.querySelector('input');
    if (firstInput) firstInput.focus({ preventScroll: true });
  }

  function message(error) {
    const labels = {
      invalid_credentials: 'Usuário ou senha inválidos.',
      too_many_attempts: 'Muitas tentativas. Aguarde alguns minutos.',
      invalid_emergency_token: 'O ADMIN_AUTH_TOKEN informado é inválido.',
      username_taken: 'Esse usuário já está em uso. Escolha outro.',
      owner_already_configured: 'A conta proprietária já foi criada. Entre normalmente.',
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
      location.replace('/admin/painel');
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

  void start();
}());
