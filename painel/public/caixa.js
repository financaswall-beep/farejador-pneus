(function () {
  'use strict';

  const TOKEN_KEY = '2w_caixa_token';
  const NAME_KEY = '2w_caixa_nome';
  const USER_KEY = '2w_caixa_usuario';
  const NOTIFICATIONS_KEY = '2w_caixa_notificacoes';
  const COMPACT_KEY = '2w_caixa_compacto';
  const form = document.getElementById('caixa-login-form');
  const username = document.getElementById('caixa-username');
  const password = document.getElementById('caixa-password');
  const remember = document.getElementById('caixa-remember');
  const submit = document.getElementById('caixa-submit');
  const error = document.getElementById('caixa-login-error');
  const loginView = document.getElementById('login-view');
  const sessionView = document.getElementById('session-view');
  const sessionName = document.getElementById('session-name');
  const profileUsername = document.getElementById('profile-username');
  const operatorLabel = document.getElementById('operator-label');
  const appHeadingTitle = document.getElementById('app-heading-title');
  const profileInitials = document.getElementById('profile-initials');
  const profileMetricSales = document.getElementById('profile-metric-sales');
  const profileMetricRevenue = document.getElementById('profile-metric-revenue');
  const notificationsToggle = document.getElementById('notifications-toggle');
  const compactToggle = document.getElementById('compact-toggle');
  const passwordModal = document.getElementById('password-modal');
  const helpModal = document.getElementById('help-modal');
  const passwordForm = document.getElementById('password-change-form');
  const currentPassword = document.getElementById('current-password');
  const newPassword = document.getElementById('new-password');
  const confirmPassword = document.getElementById('confirm-password');
  const passwordChangeError = document.getElementById('password-change-error');
  const passwordChangeSubmit = document.getElementById('password-change-submit');
  const logout = document.getElementById('caixa-logout');
  const passwordToggle = document.getElementById('password-toggle');
  const app = document.querySelector('.caixa-app');
  const salesPanel = document.getElementById('sales-panel');
  const profilePanel = document.getElementById('profile-panel');
  const periodButtons = Array.from(document.querySelectorAll('[data-period]'));
  const salesSearch = document.getElementById('sales-search-input');
  const searchClear = document.getElementById('sales-search-clear');
  const salesList = document.getElementById('sales-list');
  const salesLoading = document.getElementById('sales-loading');
  const salesError = document.getElementById('sales-error');
  const salesEmpty = document.getElementById('sales-empty');
  const salesResultCount = document.getElementById('sales-result-count');
  const metricSales = document.getElementById('metric-sales');
  const metricRevenue = document.getElementById('metric-revenue');
  const metricTicket = document.getElementById('metric-ticket');
  const receiptModal = document.getElementById('receipt-modal');
  const receiptContent = document.getElementById('receipt-content');
  const toast = document.getElementById('app-toast');
  let currentPeriod = 'today';
  let searchTimer = 0;
  let salesRequest = null;
  let toastTimer = 0;

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
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
  }

  function stored(key) {
    return sessionStorage.getItem(key) || localStorage.getItem(key) || '';
  }

  function clearSession() {
    [TOKEN_KEY, NAME_KEY, USER_KEY].forEach(function (key) {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    });
  }

  function saveSession(payload) {
    clearSession();
    const storage = remember.checked ? localStorage : sessionStorage;
    storage.setItem(TOKEN_KEY, payload.session_token);
    storage.setItem(NAME_KEY, payload.display_name || 'Operador');
    storage.setItem(USER_KEY, payload.username || username.value.trim());
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
    sessionName.textContent = name;
    operatorLabel.textContent = firstName(name);
    profileInitials.textContent = initials(name);
    profileUsername.textContent = userName || '—';
    loginView.classList.add('hidden');
    sessionView.classList.remove('hidden');
    app.classList.add('is-authenticated');
    showTab('sales');
    void loadSales();
  }

  function showLogin(message) {
    sessionView.classList.add('hidden');
    loginView.classList.remove('hidden');
    receiptModal.classList.add('hidden');
    passwordModal.classList.add('hidden');
    helpModal.classList.add('hidden');
    app.classList.remove('is-authenticated');
    error.textContent = message || '';
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
      username.focus({ preventScroll: true });
      throw new Error('invalid_session');
    }
    return response;
  }

  function setBusy(busy) {
    submit.disabled = busy;
    submit.querySelector('span').textContent = busy ? 'ENTRANDO…' : 'ABRIR FRENTE DE CAIXA';
  }

  function setSalesState(state) {
    salesLoading.classList.toggle('hidden', state !== 'loading');
    salesError.classList.toggle('hidden', state !== 'error');
    salesEmpty.classList.toggle('hidden', state !== 'empty');
    salesList.classList.toggle('hidden', state === 'loading' || state === 'error' || state === 'empty');
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

  function statusInfo(status) {
    if (status === 'cancelled') return { label: 'Cancelada', className: 'cancelled' };
    if (status === 'open' || status === 'pending') return { label: 'Em andamento', className: 'pending' };
    return { label: 'Concluída', className: 'done' };
  }

  function paymentLabel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'Não informado';
    if (normalized.includes('pix')) return 'Pix';
    if (normalized.includes('dinheiro')) return 'Dinheiro';
    if (normalized.includes('cart') || normalized.includes('crédito') || normalized.includes('débito')) return 'Cartão';
    if (normalized === 'a receber') return 'A receber';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function orderLabel(value) {
    const text = String(value || '');
    if (text.startsWith('#')) return text;
    return '#' + text.replace(/^PED-/i, '');
  }

  function itemSummary(sale) {
    const amount = Number(sale.items_quantity || 0);
    let kind = sale.item_kind || 'item';
    if (amount !== 1) {
      if (kind === 'pneu') kind = 'pneus';
      else if (kind === 'serviço') kind = 'serviços';
      else kind = 'itens';
    }
    return amount + ' ' + kind;
  }

  function saleCard(sale) {
    const article = document.createElement('article');
    const status = statusInfo(sale.status);
    article.className = 'sale-card' + (status.className === 'cancelled' ? ' sale-card--cancelled' : '');

    const icon = document.createElement('span');
    icon.className = 'sale-icon';
    if (sale.item_kind === 'pneu') {
      icon.classList.add('sale-icon--tire');
      const tireImage = document.createElement('img');
      tireImage.src = '/caixa/catalog-tire.webp';
      tireImage.alt = '';
      tireImage.loading = 'lazy';
      tireImage.decoding = 'async';
      icon.appendChild(tireImage);
    } else {
      icon.appendChild(createSvg(sale.item_kind === 'serviço' ? [
        { d: 'm14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-6.6 6.6a2.1 2.1 0 0 0 3 3l6.6-6.6a5 5 0 0 1 6.4-6.4l-3 3-3-3Z' },
      ] : [
        { d: 'M6 8h12l1 12H5L6 8Z' },
        { d: 'M9 9V6a3 3 0 0 1 6 0v3' },
      ]));
    }

    const details = document.createElement('div');
    details.className = 'sale-details';
    const heading = document.createElement('div');
    heading.className = 'sale-card-heading';
    const title = document.createElement('strong');
    title.textContent = orderLabel(sale.order_number) + ' · ' + sale.customer_name;
    const badge = document.createElement('span');
    badge.className = 'sale-status sale-status--' + status.className;
    if (status.className === 'done') {
      badge.appendChild(createSvg([{ d: 'm5 12 4 4L19 6' }]));
    }
    badge.appendChild(document.createTextNode(status.label));
    heading.append(title, badge);

    const meta = document.createElement('p');
    meta.appendChild(document.createTextNode(itemSummary(sale) + ' · '));
    const payment = document.createElement('span');
    payment.textContent = paymentLabel(sale.payment_method);
    meta.appendChild(payment);

    const footer = document.createElement('div');
    footer.className = 'sale-card-footer';
    const amount = document.createElement('strong');
    amount.className = 'sale-amount';
    amount.textContent = currency.format(Number(sale.total_amount || 0));
    const receiptButton = document.createElement('button');
    receiptButton.type = 'button';
    receiptButton.className = 'receipt-button';
    receiptButton.appendChild(createSvg([
      { d: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21V3Z' },
      { d: 'M9 8h6M9 12h6M9 16h4' },
    ]));
    receiptButton.appendChild(document.createTextNode('Ver recibo'));
    receiptButton.addEventListener('click', function () { void openReceipt(sale.order_id); });
    footer.append(amount, receiptButton);
    details.append(heading, meta, footer);
    article.append(icon, details);
    return article;
  }

  function renderSales(payload) {
    const summary = payload.summary || {};
    metricSales.textContent = String(summary.sales_count || 0);
    metricRevenue.textContent = currency.format(Number(summary.revenue || 0));
    metricTicket.textContent = currency.format(Number(summary.average_ticket || 0));
    if (payload.period === 'today') renderProfileSummary(summary);
    salesList.replaceChildren();
    const sales = Array.isArray(payload.sales) ? payload.sales : [];
    sales.forEach(function (sale) { salesList.appendChild(saleCard(sale)); });
    salesResultCount.textContent = sales.length ? sales.length + (sales.length === 1 ? ' resultado' : ' resultados') : '';
    setSalesState(sales.length ? 'ready' : 'empty');
  }

  function renderProfileSummary(summary) {
    profileMetricSales.textContent = String(summary.sales_count || 0);
    profileMetricRevenue.textContent = currency.format(Number(summary.revenue || 0));
  }

  async function loadProfileSummary() {
    try {
      const response = await authenticatedFetch('/api/caixa/vendas?period=today');
      const payload = await json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      renderProfileSummary(payload.summary || {});
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      profileMetricSales.textContent = '—';
      profileMetricRevenue.textContent = '—';
    }
  }

  async function loadSales() {
    if (!token()) return;
    if (salesRequest) salesRequest.abort();
    const controller = new AbortController();
    salesRequest = controller;
    setSalesState('loading');
    const params = new URLSearchParams({ period: currentPeriod });
    const search = salesSearch.value.trim();
    if (search) params.set('search', search);
    try {
      const response = await authenticatedFetch('/api/caixa/vendas?' + params.toString(), {
        signal: controller.signal,
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      renderSales(payload);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      setSalesState('error');
    } finally {
      if (salesRequest === controller) salesRequest = null;
    }
  }

  function textBlock(className, label, value) {
    const block = document.createElement('div');
    block.className = className;
    const small = document.createElement('small');
    small.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    block.append(small, strong);
    return block;
  }

  function renderReceipt(receipt) {
    receiptContent.replaceChildren();
    const meta = document.createElement('div');
    meta.className = 'receipt-meta';
    meta.append(
      textBlock('', 'Venda', orderLabel(receipt.order_number)),
      textBlock('', 'Data', dateTime.format(new Date(receipt.created_at))),
      textBlock('', 'Cliente', receipt.customer_name),
      textBlock('', 'Pagamento', paymentLabel(receipt.payment_method)),
      textBlock('', 'Status', statusInfo(receipt.status).label),
    );
    receiptContent.appendChild(meta);

    const itemsTitle = document.createElement('h3');
    itemsTitle.textContent = 'Itens';
    receiptContent.appendChild(itemsTitle);
    const items = document.createElement('div');
    items.className = 'receipt-items';
    (receipt.items || []).forEach(function (item) {
      const row = document.createElement('div');
      const description = document.createElement('span');
      description.textContent = item.quantity + '× ' + item.product_name;
      const value = document.createElement('strong');
      value.textContent = currency.format(Number(item.line_total || 0));
      row.append(description, value);
      items.appendChild(row);
    });
    receiptContent.appendChild(items);

    const total = document.createElement('div');
    total.className = 'receipt-total';
    const label = document.createElement('span');
    label.textContent = 'Total da venda';
    const value = document.createElement('strong');
    value.textContent = currency.format(Number(receipt.total_amount || 0));
    total.append(label, value);
    receiptContent.appendChild(total);
    if (receipt.seller_name) {
      const seller = document.createElement('p');
      seller.className = 'receipt-seller';
      seller.textContent = 'Atendimento: ' + receipt.seller_name;
      receiptContent.appendChild(seller);
    }
  }

  async function openReceipt(orderId) {
    receiptModal.classList.remove('hidden');
    receiptContent.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'receipt-loading';
    loading.textContent = 'Carregando recibo…';
    receiptContent.appendChild(loading);
    try {
      const response = await authenticatedFetch('/api/caixa/vendas/' + encodeURIComponent(orderId) + '/recibo');
      const payload = await json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      renderReceipt(payload);
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      loading.textContent = 'Não foi possível abrir este recibo.';
    }
  }

  function closeReceipt() {
    receiptModal.classList.add('hidden');
  }

  function showTab(tab) {
    const profile = tab === 'profile';
    salesPanel.classList.toggle('hidden', profile);
    profilePanel.classList.toggle('hidden', !profile);
    sessionView.classList.toggle('is-profile', profile);
    appHeadingTitle.textContent = profile ? 'Perfil' : 'Vendas';
    document.getElementById('nav-sales').classList.toggle('active', !profile);
    document.getElementById('nav-profile').classList.toggle('active', profile);
    document.getElementById('nav-sales').toggleAttribute('aria-current', !profile);
    document.getElementById('nav-profile').toggleAttribute('aria-current', profile);
    if (profile) void loadProfileSummary();
  }

  function preferenceValue(key, defaultValue) {
    const storedValue = localStorage.getItem(key);
    return storedValue === null ? defaultValue : storedValue === 'true';
  }

  function setPreference(button, key, enabled) {
    button.setAttribute('aria-checked', String(enabled));
    const label = key === NOTIFICATIONS_KEY ? 'notificações' : 'modo compacto';
    button.setAttribute('aria-label', (enabled ? 'Desativar ' : 'Ativar ') + label);
    localStorage.setItem(key, String(enabled));
    if (key === COMPACT_KEY) app.classList.toggle('compact-mode', enabled);
  }

  function applyPreferences() {
    setPreference(notificationsToggle, NOTIFICATIONS_KEY, preferenceValue(NOTIFICATIONS_KEY, true));
    setPreference(compactToggle, COMPACT_KEY, preferenceValue(COMPACT_KEY, false));
  }

  function closePasswordModal() {
    passwordModal.classList.add('hidden');
    passwordForm.reset();
    passwordChangeError.textContent = '';
  }

  function closeHelpModal() {
    helpModal.classList.add('hidden');
  }

  function passwordErrorMessage(code) {
    if (code === 'invalid_current_password') return 'A senha atual está incorreta.';
    if (code === 'same_password') return 'A nova senha precisa ser diferente da atual.';
    if (code === 'too_many_attempts') return 'Muitas tentativas. Aguarde alguns minutos.';
    return 'Não foi possível trocar a senha agora.';
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.remove('hidden');
    toastTimer = window.setTimeout(function () { toast.classList.add('hidden'); }, 3200);
  }

  passwordToggle.addEventListener('click', function () {
    const visible = password.type === 'text';
    password.type = visible ? 'password' : 'text';
    passwordToggle.setAttribute('aria-pressed', String(!visible));
    passwordToggle.setAttribute('aria-label', visible ? 'Mostrar senha' : 'Ocultar senha');
    password.focus({ preventScroll: true });
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!username.value.trim() || !password.value) {
      error.textContent = 'Preencha usuário e senha.';
      return;
    }
    setBusy(true);
    error.textContent = '';
    try {
      const response = await fetch('/api/caixa/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.value.trim(), password: password.value }),
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      saveSession(payload);
      password.value = '';
      showSession(payload.display_name, payload.username);
    } catch (failure) {
      error.textContent = errorMessage(failure instanceof Error ? failure.message : 'request_failed');
    } finally {
      setBusy(false);
    }
  });

  async function logoutCaixa() {
    const current = token();
    try {
      if (current) await authenticatedFetch('/api/caixa/logout', { method: 'POST' });
    } catch (_) {
      // O logout local continua mesmo se a rede estiver indisponível.
    }
    clearSession();
    form.reset();
    remember.checked = true;
    showLogin('');
    username.focus({ preventScroll: true });
  }

  logout.addEventListener('click', function () { void logoutCaixa(); });

  notificationsToggle.addEventListener('click', function () {
    const enabled = notificationsToggle.getAttribute('aria-checked') !== 'true';
    setPreference(notificationsToggle, NOTIFICATIONS_KEY, enabled);
    showToast(enabled ? 'Notificações ativadas neste aparelho.' : 'Notificações desativadas neste aparelho.');
  });

  compactToggle.addEventListener('click', function () {
    const enabled = compactToggle.getAttribute('aria-checked') !== 'true';
    setPreference(compactToggle, COMPACT_KEY, enabled);
    showToast(enabled ? 'Modo compacto ativado.' : 'Modo compacto desativado.');
  });

  document.getElementById('change-password-button').addEventListener('click', function () {
    passwordModal.classList.remove('hidden');
    currentPassword.focus({ preventScroll: true });
  });
  document.querySelectorAll('[data-close-password]').forEach(function (button) {
    button.addEventListener('click', closePasswordModal);
  });
  document.getElementById('help-button').addEventListener('click', function () {
    helpModal.classList.remove('hidden');
  });
  document.querySelectorAll('[data-close-help]').forEach(function (button) {
    button.addEventListener('click', closeHelpModal);
  });

  passwordForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    passwordChangeError.textContent = '';
    if (!currentPassword.value || newPassword.value.length < 12) {
      passwordChangeError.textContent = 'Informe a senha atual e uma nova senha com pelo menos 12 caracteres.';
      return;
    }
    if (newPassword.value !== confirmPassword.value) {
      passwordChangeError.textContent = 'A confirmação não corresponde à nova senha.';
      return;
    }
    passwordChangeSubmit.disabled = true;
    passwordChangeSubmit.textContent = 'SALVANDO…';
    try {
      const response = await authenticatedFetch('/api/caixa/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: currentPassword.value,
          new_password: newPassword.value,
        }),
      });
      const payload = await json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      closePasswordModal();
      clearSession();
      form.reset();
      remember.checked = true;
      showLogin('Senha alterada. Entre novamente com a nova senha.');
      username.focus({ preventScroll: true });
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      passwordChangeError.textContent = passwordErrorMessage(
        failure instanceof Error ? failure.message : 'request_failed',
      );
    } finally {
      passwordChangeSubmit.disabled = false;
      passwordChangeSubmit.textContent = 'Salvar nova senha';
    }
  });

  periodButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      currentPeriod = button.dataset.period;
      periodButtons.forEach(function (item) {
        const selected = item === button;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      void loadSales();
    });
  });

  salesSearch.addEventListener('input', function () {
    searchClear.classList.toggle('hidden', !salesSearch.value);
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () { void loadSales(); }, 320);
  });
  searchClear.addEventListener('click', function () {
    salesSearch.value = '';
    searchClear.classList.add('hidden');
    salesSearch.focus();
    void loadSales();
  });
  document.getElementById('sales-retry').addEventListener('click', function () { void loadSales(); });
  document.getElementById('operator-button').addEventListener('click', function () { showTab('profile'); });
  document.getElementById('nav-profile').addEventListener('click', function () { showTab('profile'); });
  document.getElementById('nav-sales').addEventListener('click', function () { showTab('sales'); });
  document.getElementById('nav-cash').addEventListener('click', function () {
    showToast('A tela de nova venda será a próxima etapa do Frente de Caixa.');
  });
  document.querySelectorAll('[data-close-receipt]').forEach(function (button) {
    button.addEventListener('click', closeReceipt);
  });
  document.getElementById('receipt-print').addEventListener('click', function () { window.print(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !receiptModal.classList.contains('hidden')) closeReceipt();
    else if (event.key === 'Escape' && !passwordModal.classList.contains('hidden')) closePasswordModal();
    else if (event.key === 'Escape' && !helpModal.classList.contains('hidden')) closeHelpModal();
  });

  async function start() {
    const current = token();
    if (!current) {
      username.focus({ preventScroll: true });
      return;
    }
    try {
      const response = await authenticatedFetch('/api/caixa/me');
      if (!response.ok) throw new Error('invalid_session');
      const payload = await json(response);
      showSession(payload.display_name || stored(NAME_KEY), payload.username || stored(USER_KEY));
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      clearSession();
      showLogin('Sua sessão expirou. Entre novamente.');
      username.focus({ preventScroll: true });
    }
  }

  applyPreferences();
  void start();
}());
