/**
 * login.js — porta única de login (0095). Vanilla JS, standalone (sem Alpine/CDN).
 * Fluxo: usuário+senha → POST /api/login →
 *   direct → grava a sessão na MESMA chave que o painel usa
 *            (farejador_partner_token_<slug>) e vai pra /parceiro/<slug>/.
 *   choose → mostra as lojas DA PESSOA; o clique troca o ticket (uso único,
 *            2 min) pela sessão da loja em POST /api/login/escolher.
 * REGRA: teto 300 (mesmo espírito do painel); dado dinâmico só via textContent.
 */
(function () {
  'use strict';

  var form = document.getElementById('form-login');
  var btnEntrar = document.getElementById('btn-entrar');
  var btnVoltar = document.getElementById('btn-voltar');
  var elEscolha = document.getElementById('escolha');
  var elLojas = document.getElementById('lojas');
  var elErro = document.getElementById('erro');
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
    elEscolha.style.display = 'block';
  }

  function voltarPraSenha() {
    ticket = null;
    elEscolha.style.display = 'none';
    form.style.display = 'block';
    setErro('');
    document.getElementById('password').value = '';
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

  form.addEventListener('submit', entrar);
  btnVoltar.addEventListener('click', voltarPraSenha);
})();
