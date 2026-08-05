(function () {
  'use strict';

  const Caixa = window.Caixa;
  const elements = Caixa.elements;

  function preferenceValue(key, defaultValue) {
    const storedValue = localStorage.getItem(key);
    return storedValue === null ? defaultValue : storedValue === 'true';
  }

  function setPreference(button, key, enabled) {
    button.setAttribute('aria-checked', String(enabled));
    const label = key === Caixa.keys.notifications ? 'notificações' : 'modo compacto';
    button.setAttribute('aria-label', (enabled ? 'Desativar ' : 'Ativar ') + label);
    localStorage.setItem(key, String(enabled));
    if (key === Caixa.keys.compact) elements.app.classList.toggle('compact-mode', enabled);
  }

  function applyPreferences() {
    setPreference(
      elements.notificationsToggle,
      Caixa.keys.notifications,
      preferenceValue(Caixa.keys.notifications, true),
    );
    setPreference(
      elements.compactToggle,
      Caixa.keys.compact,
      preferenceValue(Caixa.keys.compact, false),
    );
  }

  function closePasswordModal() {
    elements.passwordModal.classList.add('hidden');
    elements.passwordForm.reset();
    elements.passwordChangeError.textContent = '';
  }

  function closeHelpModal() {
    elements.helpModal.classList.add('hidden');
  }

  function passwordErrorMessage(code) {
    if (code === 'invalid_current_password') return 'A senha atual está incorreta.';
    if (code === 'same_password') return 'A nova senha precisa ser diferente da atual.';
    if (code === 'too_many_attempts') return 'Muitas tentativas. Aguarde alguns minutos.';
    return 'Não foi possível trocar a senha agora.';
  }

  async function logoutCaixa() {
    const current = Caixa.token();
    try {
      if (current) await Caixa.authenticatedFetch('/api/caixa/logout', { method: 'POST' });
    } catch (_) {
      // O logout local continua mesmo se a rede estiver indisponível.
    }
    Caixa.clearSession();
    elements.form.reset();
    elements.remember.checked = true;
    Caixa.showLogin('');
    elements.username.focus({ preventScroll: true });
  }

  Object.assign(Caixa, {
    applyPreferences: applyPreferences,
    closePasswordModal: closePasswordModal,
    closeHelpModal: closeHelpModal,
  });

  elements.logout.addEventListener('click', function () { void logoutCaixa(); });
  elements.notificationsToggle.addEventListener('click', function () {
    const enabled = elements.notificationsToggle.getAttribute('aria-checked') !== 'true';
    setPreference(elements.notificationsToggle, Caixa.keys.notifications, enabled);
    if (Caixa.setPhotoSoundEnabled) Caixa.setPhotoSoundEnabled(enabled);
    Caixa.showToast(enabled
      ? 'Notificações ativadas neste aparelho.'
      : 'Notificações desativadas neste aparelho.');
  });
  elements.compactToggle.addEventListener('click', function () {
    const enabled = elements.compactToggle.getAttribute('aria-checked') !== 'true';
    setPreference(elements.compactToggle, Caixa.keys.compact, enabled);
    Caixa.showToast(enabled ? 'Modo compacto ativado.' : 'Modo compacto desativado.');
  });
  document.getElementById('change-password-button').addEventListener('click', function () {
    elements.passwordModal.classList.remove('hidden');
    elements.currentPassword.focus({ preventScroll: true });
  });
  document.querySelectorAll('[data-close-password]').forEach(function (button) {
    button.addEventListener('click', closePasswordModal);
  });
  document.getElementById('help-button').addEventListener('click', function () {
    elements.helpModal.classList.remove('hidden');
  });
  document.querySelectorAll('[data-close-help]').forEach(function (button) {
    button.addEventListener('click', closeHelpModal);
  });

  elements.passwordForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    elements.passwordChangeError.textContent = '';
    if (!elements.currentPassword.value || elements.newPassword.value.length < 12) {
      elements.passwordChangeError.textContent =
        'Informe a senha atual e uma nova senha com pelo menos 12 caracteres.';
      return;
    }
    if (elements.newPassword.value !== elements.confirmPassword.value) {
      elements.passwordChangeError.textContent = 'A confirmação não corresponde à nova senha.';
      return;
    }
    elements.passwordChangeSubmit.disabled = true;
    elements.passwordChangeSubmit.textContent = 'SALVANDO…';
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: elements.currentPassword.value,
          new_password: elements.newPassword.value,
        }),
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      closePasswordModal();
      Caixa.clearSession();
      elements.form.reset();
      elements.remember.checked = true;
      Caixa.showLogin('Senha alterada. Entre novamente com a nova senha.');
      elements.username.focus({ preventScroll: true });
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      elements.passwordChangeError.textContent = passwordErrorMessage(
        failure instanceof Error ? failure.message : 'request_failed',
      );
    } finally {
      elements.passwordChangeSubmit.disabled = false;
      elements.passwordChangeSubmit.textContent = 'Salvar nova senha';
    }
  });
}());
