(function () {
  'use strict';

  const Caixa = window.Caixa;
  const elements = Caixa.elements;

  elements.passwordToggle.addEventListener('click', function () {
    const visible = elements.password.type === 'text';
    elements.password.type = visible ? 'password' : 'text';
    elements.passwordToggle.setAttribute('aria-pressed', String(!visible));
    elements.passwordToggle.setAttribute('aria-label', visible ? 'Mostrar senha' : 'Ocultar senha');
    elements.password.focus({ preventScroll: true });
  });

  elements.form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!elements.username.value.trim() || !elements.password.value) {
      elements.error.textContent = 'Preencha usuário e senha.';
      return;
    }
    Caixa.setBusy(true);
    elements.error.textContent = '';
    try {
      const response = await fetch('/api/caixa/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: elements.username.value.trim(),
          password: elements.password.value,
        }),
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.saveSession(payload);
      elements.password.value = '';
      Caixa.showSession(payload.display_name, payload.username);
    } catch (failure) {
      elements.error.textContent = Caixa.errorMessage(
        failure instanceof Error ? failure.message : 'request_failed',
      );
    } finally {
      Caixa.setBusy(false);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!elements.receiptModal.classList.contains('hidden')) Caixa.closeReceipt();
    else if (!elements.passwordModal.classList.contains('hidden')) Caixa.closePasswordModal();
    else if (!elements.helpModal.classList.contains('hidden')) Caixa.closeHelpModal();
  });

  async function start() {
    const current = Caixa.token();
    if (!current) {
      elements.username.focus({ preventScroll: true });
      return;
    }
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/me');
      if (!response.ok) throw new Error('invalid_session');
      const payload = await Caixa.json(response);
      Caixa.showSession(
        payload.display_name || Caixa.stored(Caixa.keys.name),
        payload.username || Caixa.stored(Caixa.keys.user),
      );
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      Caixa.clearSession();
      Caixa.showLogin('Sua sessão expirou. Entre novamente.');
      elements.username.focus({ preventScroll: true });
    }
  }

  Caixa.applyPreferences();
  void start();
}());
