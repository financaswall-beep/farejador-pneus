/**
 * app.auth.js - fabrica `auth` do painel do parceiro (obra <=300, passo 10/11).
 * MORA AQUI: sessao e credencial - applySession (guarda o token ps_ no aparelho),
 * login (usuario+senha -> sessao), firstAccess (P1: dono cola o codigo uma vez e
 * define usuario+senha) e logout (revoga no servidor + limpa o estado local).
 * NAO MORA AQUI: apiHeaders/api/loadData (app.core.js); isOwner/canSee
 * (app.config.js). A porta UNICA de login (pos-obra) nasce em cima deste arquivo.
 * VEIO DE: app.js commit 29e9817 (range 340-449), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.auth = () => ({
    // â”€â”€â”€ AUTH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Guarda o token de SESSÃO (ps_…) emitido pelo login. É o que o navegador
    // manda como Bearer daqui pra frente (no lugar do código de acesso cru).
    applySession(token) {
      this.apiToken = token || '';
      if (token) localStorage.setItem(this.tokenKey, token);
    },

    // Login normal: usuário + senha → sessão.
    async login() {
      const username = (this.loginUsername || '').trim();
      const password = this.loginPassword || '';
      if (!username || !password) { this.loginError = 'Informe usuário e senha.'; return; }
      this.loading = true;
      this.loginError = '';
      try {
        const res = await fetch(`/parceiro/${this.slug}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          if (res.status === 429) this.loginError = 'Muitas tentativas. Espere alguns minutos e tente de novo.';
          else if (res.status === 401) this.loginError = 'Usuário ou senha incorretos.';
          else this.loginError = 'Não foi possível entrar agora. Tente de novo.';
          return;
        }
        const data = await res.json();
        this.applySession(data.session_token);
        await this.loadData();
        this.authed = true;
        this.loginPassword = '';
        this.unlockAudio();        // clique do Entrar = gesto que destrava o bip
        this.startPhotoGlobal();   // alerta de foto vive desde o login
      } catch (err) {
        this.loginError = this.errMessage(err);
        this.applySession('');
      } finally {
        this.loading = false;
      }
    },

    // Primeiro acesso do dono: cola o código de acesso (uma vez) e escolhe
    // usuário+senha. O backend define as credenciais e já devolve uma sessão.
    async firstAccess() {
      const token = (this.tokenInput || '').trim();
      const username = (this.loginUsername || '').trim();
      const password = this.loginPassword || '';
      if (!token) { this.loginError = 'Cole o código de acesso que você recebeu.'; return; }
      if (!username || password.length < 6) {
        this.loginError = 'Escolha um usuário e uma senha de pelo menos 6 caracteres.';
        return;
      }
      this.loading = true;
      this.loginError = '';
      try {
        const res = await fetch(`/parceiro/${this.slug}/api/set-credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          if (res.status === 429) this.loginError = 'Muitas tentativas. Espere alguns minutos e tente de novo.';
          else if (res.status === 401) this.loginError = 'Código de acesso inválido ou expirado.';
          else if (payload.error === 'username_taken') this.loginError = 'Esse usuário já existe. Escolha outro.';
          else if (payload.error === 'credentials_already_set') this.loginError = 'Esse login já tem senha. Entre com usuário e senha.';
          else this.loginError = 'Não foi possível concluir o primeiro acesso.';
          return;
        }
        const data = await res.json();
        this.applySession(data.session_token);
        await this.loadData();
        this.authed = true;
        this.loginPassword = '';
        this.tokenInput = '';
        this.loginMode = 'login';
        this.unlockAudio();
        this.startPhotoGlobal();
        this.flash('Pronto! Da próxima vez é só usuário e senha.');
      } catch (err) {
        this.loginError = this.errMessage(err);
      } finally {
        this.loading = false;
      }
    },

    async logout() {
      // Revoga a sessão no servidor (idempotente; código cru = no-op).
      try {
        await fetch(`/parceiro/${this.slug}/api/logout`, { method: 'POST', headers: this.apiHeaders(false) });
      } catch (e) { /* offline: o front limpa local mesmo assim */ }
      this.stopPhotoGlobal();
      this.photoRequests = [];
      this.apiToken = '';
      this.tokenInput = '';
      this.loginUsername = '';
      this.loginPassword = '';
      this.loginMode = 'login';
      localStorage.removeItem(this.tokenKey);
      this.authed = false;
      this.resumo = null;
      this.vendas = [];
      this.estoque = [];
      this.compras = [];
      this.despesas = [];
      this.produtos = [];
      this.payables = [];
      this.receivables = [];
    },
});
