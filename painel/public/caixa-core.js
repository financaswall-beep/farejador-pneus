(function () {
  'use strict';

  const Caixa = window.Caixa = window.Caixa || {};
  const keys = {
    token: '2w_caixa_token',
    name: '2w_caixa_nome',
    user: '2w_caixa_usuario',
    notifications: '2w_caixa_notificacoes',
    compact: '2w_caixa_compacto',
  };
  const byId = function (id) { return document.getElementById(id); };
  const elements = {
    form: byId('caixa-login-form'),
    username: byId('caixa-username'),
    password: byId('caixa-password'),
    remember: byId('caixa-remember'),
    submit: byId('caixa-submit'),
    error: byId('caixa-login-error'),
    loginView: byId('login-view'),
    sessionView: byId('session-view'),
    sessionName: byId('session-name'),
    profileUsername: byId('profile-username'),
    operatorLabel: byId('operator-label'),
    appHeadingTitle: byId('app-heading-title'),
    profileInitials: byId('profile-initials'),
    profileMetricSales: byId('profile-metric-sales'),
    profileMetricRevenue: byId('profile-metric-revenue'),
    notificationsToggle: byId('notifications-toggle'),
    compactToggle: byId('compact-toggle'),
    passwordModal: byId('password-modal'),
    helpModal: byId('help-modal'),
    passwordForm: byId('password-change-form'),
    currentPassword: byId('current-password'),
    newPassword: byId('new-password'),
    confirmPassword: byId('confirm-password'),
    passwordChangeError: byId('password-change-error'),
    passwordChangeSubmit: byId('password-change-submit'),
    logout: byId('caixa-logout'),
    passwordToggle: byId('password-toggle'),
    app: document.querySelector('.caixa-app'),
    cashPanel: byId('cash-panel'),
    salesPanel: byId('sales-panel'),
    profilePanel: byId('profile-panel'),
    periodButtons: Array.from(document.querySelectorAll('[data-period]')),
    salesSearch: byId('sales-search-input'),
    searchClear: byId('sales-search-clear'),
    salesList: byId('sales-list'),
    salesLoading: byId('sales-loading'),
    salesError: byId('sales-error'),
    salesEmpty: byId('sales-empty'),
    salesResultCount: byId('sales-result-count'),
    metricSales: byId('metric-sales'),
    metricRevenue: byId('metric-revenue'),
    metricTicket: byId('metric-ticket'),
    receiptModal: byId('receipt-modal'),
    customerModal: byId('checkout-customer-modal'),
    checkoutReviewModal: byId('checkout-review-modal'),
    receiptContent: byId('receipt-content'),
    toast: byId('app-toast'),
  };
  const state = {
    currentPeriod: 'today',
    searchTimer: 0,
    salesRequest: null,
    toastTimer: 0,
  };
  const currency = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
  const dateTime = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  });

  function token() {
    return sessionStorage.getItem(keys.token) || localStorage.getItem(keys.token) || '';
  }

  function stored(key) {
    return sessionStorage.getItem(key) || localStorage.getItem(key) || '';
  }

  function clearSession() {
    [keys.token, keys.name, keys.user].forEach(function (key) {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    });
  }

  function saveSession(payload) {
    clearSession();
    const storage = elements.remember.checked ? localStorage : sessionStorage;
    storage.setItem(keys.token, payload.session_token);
    storage.setItem(keys.name, payload.display_name || 'Operador');
    storage.setItem(keys.user, payload.username || elements.username.value.trim());
  }

  function firstName(value) {
    return String(value || 'Operador').trim().split(/\s+/)[0] || 'Operador';
  }

  function initials(value) {
    const words = String(value || 'Operador').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'OP';
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : (words[0][1] || ''))).toUpperCase();
  }

  function showSession(displayName, userName) {
    const name = displayName || 'Operador';
    elements.sessionName.textContent = name;
    elements.operatorLabel.textContent = firstName(name);
    elements.profileInitials.textContent = initials(name);
    elements.profileUsername.textContent = userName || '—';
    elements.loginView.classList.add('hidden');
    elements.sessionView.classList.remove('hidden');
    elements.app.classList.add('is-authenticated');
    Caixa.showTab('cash');
    void Caixa.loadCatalog();
  }

  function showLogin(message) {
    elements.sessionView.classList.add('hidden');
    elements.loginView.classList.remove('hidden');
    elements.receiptModal.classList.add('hidden');
    elements.customerModal.classList.add('hidden');
    elements.checkoutReviewModal.classList.add('hidden');
    elements.passwordModal.classList.add('hidden');
    elements.helpModal.classList.add('hidden');
    elements.app.classList.remove('is-authenticated');
    elements.error.textContent = message || '';
  }

  function errorMessage(code) {
    if (code === 'too_many_attempts') return 'Muitas tentativas. Aguarde alguns minutos.';
    if (code === 'invalid_credentials') return 'Usuário ou senha inválidos para o Frente de Caixa.';
    return 'Não foi possível entrar agora. Tente novamente.';
  }

  async function json(response) {
    return response.json().catch(function () { return {}; });
  }

  async function authenticatedFetch(url, options) {
    const headers = Object.assign({}, options && options.headers, {
      Authorization: 'Bearer ' + token(),
    });
    const response = await fetch(url, Object.assign({}, options, { headers: headers }));
    if (response.status === 401) {
      clearSession();
      showLogin('Sua sessão expirou. Entre novamente.');
      elements.username.focus({ preventScroll: true });
      throw new Error('invalid_session');
    }
    return response;
  }

  function setBusy(busy) {
    elements.submit.disabled = busy;
    elements.submit.querySelector('span').textContent = busy ? 'ENTRANDO…' : 'ABRIR FRENTE DE CAIXA';
  }

  function createSvg(paths, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    paths.forEach(function (definition) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', definition.tag || 'path');
      Object.keys(definition).forEach(function (key) {
        if (key !== 'tag') path.setAttribute(key, definition[key]);
      });
      svg.appendChild(path);
    });
    return svg;
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.remove('hidden');
    state.toastTimer = window.setTimeout(function () { elements.toast.classList.add('hidden'); }, 3200);
  }

  Object.assign(Caixa, {
    keys: keys,
    elements: elements,
    state: state,
    currency: currency,
    dateTime: dateTime,
    token: token,
    stored: stored,
    clearSession: clearSession,
    saveSession: saveSession,
    showSession: showSession,
    showLogin: showLogin,
    errorMessage: errorMessage,
    json: json,
    authenticatedFetch: authenticatedFetch,
    setBusy: setBusy,
    createSvg: createSvg,
    showToast: showToast,
  });
}());
