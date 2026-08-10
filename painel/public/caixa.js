(function () {
  'use strict';

  const Caixa = window.Caixa;
  const elements = Caixa.elements;
  let pendingTicket = '';

  function resetWorkplaceChooser() {
    pendingTicket = '';
    elements.workplaceList.replaceChildren();
    elements.workplaceError.textContent = '';
    elements.workplaceChooser.classList.add('hidden');
    elements.form.classList.remove('hidden');
  }

  function completeLogin(payload) {
    Caixa.saveSession(payload);
    if (payload.scope === 'partner' && payload.modules && payload.modules.vendas === false) {
      window.location.assign('/parceiro/' + encodeURIComponent(payload.slug) + '/');
      return;
    }
    Caixa.showSession(payload);
  }

  function workplaceIcon(kind) {
    if (kind === 'matrix') {
      return Caixa.createSvg([
        { d: 'M5 21V4h14v17M9 8h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1M3 21h18' },
      ]);
    }
    return Caixa.createSvg([
      { d: 'M4 10h16M5 10v10h14V10M3 6h18l-1 4H4L3 6Z' },
      { d: 'M9 20v-6h6v6' },
    ]);
  }

  function showWorkplaceChooser(payload) {
    pendingTicket = payload.ticket;
    elements.password.value = '';
    elements.form.classList.add('hidden');
    elements.workplaceChooser.classList.remove('hidden');
    elements.workplaceList.replaceChildren();
    (payload.workplaces || []).forEach(function (workplace) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workplace-option';
      button.dataset.workplaceId = workplace.id;
      button.appendChild(workplaceIcon(workplace.kind));

      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = workplace.name;
      const subtitle = document.createElement('small');
      subtitle.textContent = workplace.kind === 'matrix' ? 'Matriz · Vendas' : 'Unidade parceira · ' + (workplace.role === 'owner' ? 'Proprietário' : 'Funcionário');
      copy.append(title, subtitle);
      button.appendChild(copy);
      button.appendChild(Caixa.createSvg([{ d: 'm9 18 6-6-6-6' }]));
      elements.workplaceList.appendChild(button);
    });
    const first = elements.workplaceList.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  async function chooseWorkplace(workplaceId) {
    const buttons = Array.from(elements.workplaceList.querySelectorAll('button'));
    buttons.forEach(function (button) { button.disabled = true; });
    elements.workplaceError.textContent = '';
    try {
      const response = await fetch('/api/caixa/login/escolher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: pendingTicket, workplace_id: workplaceId }),
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      completeLogin(payload);
    } catch (failure) {
      elements.workplaceError.textContent = Caixa.errorMessage(
        failure instanceof Error ? failure.message : 'request_failed',
      );
      buttons.forEach(function (button) { button.disabled = false; });
    }
  }

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
      elements.password.value = '';
      if (payload.mode === 'choose') {
        showWorkplaceChooser(payload);
        return;
      }
      completeLogin(payload);
    } catch (failure) {
      elements.error.textContent = Caixa.errorMessage(
        failure instanceof Error ? failure.message : 'request_failed',
      );
    } finally {
      Caixa.setBusy(false);
    }
  });

  elements.workplaceList.addEventListener('click', function (event) {
    const button = event.target.closest('.workplace-option');
    if (!button || button.disabled) return;
    void chooseWorkplace(button.dataset.workplaceId || '');
  });

  elements.workplaceBack.addEventListener('click', function () {
    resetWorkplaceChooser();
    elements.username.focus({ preventScroll: true });
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!elements.workplaceChooser.classList.contains('hidden')) {
      resetWorkplaceChooser();
      elements.username.focus({ preventScroll: true });
    } else if (!elements.receiptModal.classList.contains('hidden')) Caixa.closeReceipt();
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
      const response = await Caixa.authenticatedFetch(Caixa.operationPath('me', '/api/caixa/me'));
      if (!response.ok) throw new Error('invalid_session');
      const payload = await Caixa.json(response);
      if (Caixa.isPartner() && payload.permissions && payload.permissions.vendas === false) {
        window.location.assign('/parceiro/' + encodeURIComponent(Caixa.slug()) + '/');
        return;
      }
      Caixa.showSession(payload);
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
