/**
 * PORTAL DO ENTREGADOR — front mobile (0125). Standalone, Alpine.
 *
 * Segurança (revisão 07-04): a PÁGINA é pública; os DADOS só saem com sessão es_
 * (localStorage). NUNCA usa innerHTML de dado do servidor — só x-text/x-model
 * (Alpine escapa). Sessão inválida/expirada/revogada → 401 → volta pro login.
 */
function entregasApp() {
  return {
    token: localStorage.getItem('farejador_entregador_token') || '',
    displayName: localStorage.getItem('farejador_entregador_nome') || '',
    loginForm: { username: '', password: '' },
    logando: false,
    loginMsg: '',

    rotaAberta: null,
    fila: [],
    selecionadas: [],
    kmInicial: '',
    fecharForm: { km_end: '', fuel_spent: '' },
    pagando: null,
    salvando: false,
    uploadando: false,
    comprovantesOk: 0,
    msg: null,

    init() {
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
      if (this.token) this.carregar();
    },

    // ─── API ───
    async api(method, path, body) {
      const opts = { method, headers: {} };
      if (this.token) opts.headers.Authorization = `Bearer ${this.token}`;
      if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      const res = await fetch(path, opts);
      if (res.status === 401 && this.token) { this.forcarLogout(); throw new Error('sessao_expirada'); }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const e = new Error(payload.error || `api_${res.status}`); e.status = res.status; throw e;
      }
      return res.json();
    },

    async fazerLogin() {
      if (!this.loginForm.username.trim() || !this.loginForm.password) { this.loginMsg = 'Preenche usuário e senha.'; return; }
      this.logando = true; this.loginMsg = '';
      try {
        const res = await fetch('/api/entregas/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: this.loginForm.username.trim(), password: this.loginForm.password }),
        });
        if (!res.ok) {
          this.loginMsg = res.status === 429 ? 'Muitas tentativas — espera uns minutos.' : 'Usuário ou senha errado.';
          return;
        }
        const data = await res.json();
        this.token = data.session_token;
        this.displayName = data.display_name || '';
        localStorage.setItem('farejador_entregador_token', this.token);
        localStorage.setItem('farejador_entregador_nome', this.displayName);
        this.loginForm = { username: '', password: '' };
        await this.carregar();
      } catch (err) {
        this.loginMsg = 'Não consegui entrar agora. Tenta de novo.';
      } finally {
        this.logando = false;
      }
    },

    forcarLogout() {
      this.token = ''; this.displayName = '';
      localStorage.removeItem('farejador_entregador_token');
      localStorage.removeItem('farejador_entregador_nome');
      this.loginMsg = 'Tua sessão expirou — entra de novo.';
    },

    async sair() {
      try { await this.api('POST', '/api/entregas/logout'); } catch (e) { /* ignora */ }
      this.forcarLogout();
      this.loginMsg = '';
    },

    async carregar() {
      try {
        const data = await this.api('GET', '/api/entregas/minha-rota');
        this.displayName = data.display_name || this.displayName;
        this.rotaAberta = data.rota_aberta;
        this.fila = data.fila || [];
        this.comprovantesOk = 0;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      } catch (err) {
        if (err.message !== 'sessao_expirada') this.msg = { ok: false, text: 'Não consegui carregar a rota.' };
      }
    },

    async abrirRota() {
      if (this.selecionadas.length === 0) return;
      this.salvando = true; this.msg = null;
      try {
        const r = await this.api('POST', '/api/entregas/rota/abrir', {
          km_start: this.kmInicial === '' ? null : Number(this.kmInicial),
          order_ids: this.selecionadas,
        });
        this.msg = { ok: true, text: `Rota aberta com ${r.deliveries_count} entrega(s). Boa!` };
        this.selecionadas = []; this.kmInicial = '';
        await this.carregar();
      } catch (err) {
        this.msg = { ok: false, text: err.message === 'trip_already_open'
          ? 'Você já tem uma rota aberta.' : 'Não consegui abrir a rota.' };
      } finally { this.salvando = false; }
    },

    async entreguei(d, pm) {
      this.salvando = true; this.msg = null;
      try {
        await this.api('POST', '/api/entregas/status', { order_id: d.order_id, status: 'delivered', payment_method: pm });
        this.pagando = null;
        this.msg = { ok: true, text: 'Entrega confirmada!' };
        await this.carregar();
      } catch (err) {
        this.msg = { ok: false, text: 'Não consegui confirmar a entrega.' };
      } finally { this.salvando = false; }
    },

    async naoEntreguei(d) {
      const motivo = prompt('O que aconteceu? (ex.: cliente não estava, endereço errado)');
      if (motivo === null) return;
      if (!motivo.trim()) { this.msg = { ok: false, text: 'Preciso do motivo.' }; return; }
      this.salvando = true; this.msg = null;
      try {
        await this.api('POST', '/api/entregas/nao-entregue', { order_id: d.order_id, reason: motivo.trim() });
        this.msg = { ok: true, text: 'Anotado — o escritório vai ver.' };
        await this.carregar();
      } catch (err) {
        this.msg = { ok: false, text: 'Não consegui registrar.' };
      } finally { this.salvando = false; }
    },

    async subirComprovante(ev) {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      this.uploadando = true; this.msg = null;
      try {
        const res = await fetch('/api/entregas/rota/comprovante', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': file.type || 'image/jpeg' },
          body: file,
        });
        if (res.status === 401) { this.forcarLogout(); return; }
        if (!res.ok) throw new Error('upload');
        this.comprovantesOk += 1;
        this.msg = { ok: true, text: 'Comprovante enviado.' };
      } catch (err) {
        this.msg = { ok: false, text: 'Não consegui enviar a foto.' };
      } finally {
        this.uploadando = false;
        ev.target.value = '';
      }
    },

    async fecharRota() {
      if (!confirm('Fechar a rota do dia?')) return;
      this.salvando = true; this.msg = null;
      try {
        await this.api('POST', '/api/entregas/rota/fechar', {
          km_end: this.fecharForm.km_end === '' ? null : Number(this.fecharForm.km_end),
          fuel_spent: this.fecharForm.fuel_spent === '' ? null : Number(this.fecharForm.fuel_spent),
        });
        this.msg = { ok: true, text: 'Rota fechada. Bom descanso!' };
        this.fecharForm = { km_end: '', fuel_spent: '' };
        await this.carregar();
      } catch (err) {
        this.msg = { ok: false, text: 'Não consegui fechar a rota.' };
      } finally { this.salvando = false; }
    },

    // ─── Helpers de exibição ───
    brl(v) {
      const n = Number(v || 0);
      return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    },
    itensText(d) {
      if (!d.items || !d.items.length) return '';
      return d.items.map((i) => `${i.quantity}× ${i.label}`).join(', ');
    },
    badgeText(d) {
      const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
      const dt = this.parseData(d.scheduled_date);
      if (!dt) return '';
      if (dt < hoje) return 'atrasada';
      if (dt.getTime() === hoje.getTime()) return 'hoje';
      return 'amanhã';
    },
    badgeClass(d) {
      const t = this.badgeText(d);
      if (t === 'atrasada') return 'bg-rose-100 text-rose-700';
      if (t === 'hoje') return 'bg-amber-100 text-amber-700';
      return 'bg-slate-100 text-slate-500';
    },
    parseData(s) {
      if (!s) return null;
      const [y, m, d] = s.split('-').map(Number);
      if (!y || !m || !d) return null;
      const dt = new Date(y, m - 1, d); dt.setHours(0, 0, 0, 0);
      return dt;
    },
    horaSaida(iso) {
      try { return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
      catch (e) { return ''; }
    },
    whatsUrl(d) {
      const digits = String(d.customer_phone || '').replace(/\D/g, '');
      if (!digits) return '#';
      const tel = digits.startsWith('55') ? digits : '55' + digits;
      return 'https://wa.me/' + tel;
    },
    wazeUrl(d) {
      if (!d.delivery_address) return '#';
      return 'https://waze.com/ul?q=' + encodeURIComponent(d.delivery_address) + '&navigate=yes';
    },
    mapsUrl(d) {
      if (!d.delivery_address) return '#';
      return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(d.delivery_address);
    },
  };
}
