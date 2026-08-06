/**
 * login.js — porta única de login (0095). Vanilla JS, standalone (sem Alpine/CDN).
 * Fluxo: usuário+senha → POST /api/login →
 *   direct → grava a sessão na MESMA chave que o painel usa
 *            (farejador_partner_token_<slug>) e vai pra /parceiro/<slug>/.
 *   choose → mostra as lojas DA PESSOA; o clique troca o ticket (uso único,
 *            2 min) pela sessão da loja em POST /api/login/escolher.
 *   primeiro acesso → código cru + slug definem usuário/senha aqui; a resposta
 *                     já vira sessão e abre a loja correta.
 * REGRA: teto 300 (mesmo espírito do painel); dado dinâmico só via textContent.
 */
(function () {
  'use strict';

  var form = document.getElementById('form-login');
  var formPrimeiro = document.getElementById('form-primeiro');
  var btnEntrar = document.getElementById('btn-entrar');
  var btnCriar = document.getElementById('btn-criar');
  var btnPrimeiro = document.getElementById('btn-primeiro');
  var btnJaTenho = document.getElementById('btn-ja-tenho');
  var btnVoltar = document.getElementById('btn-voltar');
  var elEscolha = document.getElementById('escolha');
  var elLojas = document.getElementById('lojas');
  var elErro = document.getElementById('erro');
  var tituloAcesso = document.getElementById('titulo-acesso');
  var subtituloAcesso = document.getElementById('subtitulo-acesso');
  var ticket = null;

  function setErro(msg) { elErro.textContent = msg || ''; }

  function msgDoStatus(status, payload) {
    if (status === 429) return 'Muitas tentativas. Espere alguns minutos e tente de novo.';
    if (status === 401 && payload && payload.error === 'ticket_invalid') {
      return 'A escolha expirou. Digite usuário e senha de novo.';
    }
    if (status === 401) return 'Usuário ou senha incorretos.';
    return 'Não foi possível entrar agora. Tente de novo.';
  }

  function msgPrimeiroAcesso(status, payload) {
    if (status === 429) return 'Muitas tentativas. Espere alguns minutos e tente de novo.';
    if (status === 401) return 'Código de acesso ou endereço da loja incorreto.';
    if (status === 409 && payload && payload.error === 'username_taken') return 'Esse usuário já existe. Escolha outro.';
    if (status === 409 && payload && payload.error === 'credentials_already_set') return 'Esse acesso já foi configurado. Entre com usuário e senha.';
    if (status === 400) return 'Confira o endereço da loja, o usuário e a senha.';
    return 'Não foi possível criar o acesso agora. Tente de novo.';
  }

  // Mesma chave do painel (app.js): o painel abre já logado depois do redirect.
  function entrarNaLoja(slug, sessionToken) {
    try {
      localStorage.setItem('farejador_partner_token_' + slug, sessionToken);
    } catch (e) {
      setErro('Seu navegador bloqueou o armazenamento. Libere e tente de novo.');
      return;
    }
    window.location.href = '/parceiro/' + encodeURIComponent(slug) + '/';
  }

  function papelLabel(role) { return role === 'owner' ? 'dono' : 'funcionário'; }

  function mostrarEscolha(stores) {
    elLojas.textContent = '';
    stores.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'loja-btn';
      var nome = document.createElement('span');
      nome.className = 'loja-nome';
      nome.textContent = s.store_name || s.slug;
      var papel = document.createElement('span');
      papel.className = 'loja-papel';
      papel.textContent = papelLabel(s.role);
      btn.appendChild(nome);
      btn.appendChild(papel);
      btn.addEventListener('click', function () { escolher(s.slug, btn); });
      elLojas.appendChild(btn);
    });
    form.style.display = 'none';
    tituloAcesso.textContent = 'Escolha sua loja';
    subtituloAcesso.textContent = 'Seu acesso está ligado a mais de uma unidade.';
    elEscolha.style.display = 'block';
  }

  function voltarPraSenha() {
    ticket = null;
    elEscolha.style.display = 'none';
    formPrimeiro.style.display = 'none';
    form.style.display = 'grid';
    tituloAcesso.textContent = 'Bem-vindo de volta!';
    subtituloAcesso.textContent = 'Entre com seu usuário. A gente encontra sua loja.';
    setErro('');
    document.getElementById('password').value = '';
  }

  function mostrarPrimeiroAcesso() {
    ticket = null;
    form.style.display = 'none';
    elEscolha.style.display = 'none';
    formPrimeiro.style.display = 'grid';
    tituloAcesso.textContent = 'Crie seu acesso';
    subtituloAcesso.textContent = 'Configure uma vez. Depois é só entrar com usuário e senha.';
    setErro('');
    document.getElementById('first-code').focus();
  }

  async function postJson(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var payload = null;
    try { payload = await res.json(); } catch (e) { /* corpo vazio */ }
    return { ok: res.ok, status: res.status, payload: payload };
  }

  async function entrar(ev) {
    ev.preventDefault();
    setErro('');
    var username = (document.getElementById('username').value || '').trim();
    var password = document.getElementById('password').value || '';
    if (!username || !password) { setErro('Informe usuário e senha.'); return; }

    btnEntrar.disabled = true;
    try {
      var r = await postJson('/api/login', { username: username, password: password });
      if (!r.ok) { setErro(msgDoStatus(r.status, r.payload)); return; }
      if (r.payload.mode === 'direct') {
        entrarNaLoja(r.payload.slug, r.payload.session_token);
        return;
      }
      ticket = r.payload.ticket;
      mostrarEscolha(r.payload.stores || []);
    } catch (e) {
      setErro('Sem conexão. Verifique a internet e tente de novo.');
    } finally {
      btnEntrar.disabled = false;
    }
  }

  async function escolher(slug, btn) {
    if (!ticket) { voltarPraSenha(); return; }
    setErro('');
    btn.disabled = true;
    try {
      var r = await postJson('/api/login/escolher', { ticket: ticket, slug: slug });
      if (!r.ok) {
        // Ticket é uso único: qualquer falha aqui volta pro começo.
        voltarPraSenha();
        setErro(msgDoStatus(r.status, r.payload));
        return;
      }
      entrarNaLoja(r.payload.slug, r.payload.session_token);
    } catch (e) {
      btn.disabled = false;
      setErro('Sem conexão. Verifique a internet e tente de novo.');
    }
  }

  async function criarPrimeiroAcesso(ev) {
    ev.preventDefault();
    setErro('');
    var slug = (document.getElementById('first-slug').value || '').trim().toLowerCase();
    var code = (document.getElementById('first-code').value || '').trim();
    var username = (document.getElementById('first-username').value || '').trim();
    var password = document.getElementById('first-password').value || '';
    if (!/^[a-z0-9-]{2,80}$/.test(slug)) { setErro('Informe o endereço da loja, como borracharia-rio-do-ouro.'); return; }
    if (!code || !username || password.length < 6) { setErro('Preencha o código, o usuário e uma senha de pelo menos 6 caracteres.'); return; }

    btnCriar.disabled = true;
    try {
      var res = await fetch('/parceiro/' + encodeURIComponent(slug) + '/api/set-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + code },
        body: JSON.stringify({ username: username, password: password }),
      });
      var payload = null;
      try { payload = await res.json(); } catch (e) { /* corpo vazio */ }
      if (!res.ok) { setErro(msgPrimeiroAcesso(res.status, payload)); return; }
      entrarNaLoja(slug, payload.session_token);
    } catch (e) {
      setErro('Sem conexão. Verifique a internet e tente de novo.');
    } finally {
      btnCriar.disabled = false;
    }
  }

  form.addEventListener('submit', entrar);
  formPrimeiro.addEventListener('submit', criarPrimeiroAcesso);
  btnVoltar.addEventListener('click', voltarPraSenha);
  btnPrimeiro.addEventListener('click', mostrarPrimeiroAcesso);
  btnJaTenho.addEventListener('click', voltarPraSenha);

  document.querySelectorAll('[data-password-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      var input = document.getElementById(button.getAttribute('data-password-toggle'));
      if (!input) return;
      var mostrar = input.type === 'password';
      input.type = mostrar ? 'text' : 'password';
      button.setAttribute('aria-pressed', mostrar ? 'true' : 'false');
      button.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
    });
  });

  var params = new URLSearchParams(window.location.search);
  var slugInicial = (params.get('loja') || '').trim().toLowerCase();
  if (/^[a-z0-9-]{2,80}$/.test(slugInicial)) document.getElementById('first-slug').value = slugInicial;
  if (params.get('primeiro') === '1') mostrarPrimeiroAcesso();
  if (params.get('sessao') === 'expirada') setErro('Sua sessão terminou. Entre novamente.');
})();
