(function () {
  const loading = document.getElementById('loading');
  const loginForm = document.getElementById('login-form');
  const bootstrapForm = document.getElementById('bootstrap-form');

  function show(form) {
    loading.classList.add('hidden');
    loginForm.classList.toggle('hidden', form !== loginForm);
    bootstrapForm.classList.toggle('hidden', form !== bootstrapForm);
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
    const button = loginForm.querySelector('button');
    const error = document.getElementById('login-error');
    button.disabled = true; error.textContent = '';
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
      button.disabled = false;
    }
  });

  bootstrapForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = bootstrapForm.querySelector('button');
    const error = document.getElementById('bootstrap-error');
    button.disabled = true; error.textContent = '';
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
      button.disabled = false;
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
