/**
 * app.core.js - fabrica `core` do painel do parceiro (obra <=300, passo 10/11).
 * MORA AQUI: o encanamento - init (boot: token salvo, 401 volta pro login, F2/Esc
 * do PDV, isMobile, resize), toggleSidebar/toggleTheme, relogio do footer
 * (nowClockLabel/nowDateLabel), apiHeaders/api (fetch com Bearer + erro com
 * status/payload), loadData (/me primeiro -> role/permissions -> feeds por canSee)
 * e navegacao (currentSectionMeta + goToSection).
 * NAO MORA AQUI: login/logout/firstAccess (app.auth.js); canSee (app.config.js).
 * VEIO DE: app.js commit 29e9817 (ranges 237-338, 451-547, 979-1038), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.core = () => ({
    // â”€â”€â”€ INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Recolhe/expande o menu lateral (só ícones <-> completo). Libera largura pra tela.
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      try { localStorage.setItem(`farejador_sidebar_collapsed_${this.slug}`, this.sidebarCollapsed ? '1' : '0'); }
      catch (e) { /* localStorage indisponível: estado só nesta sessão */ }
      // largura do conteúdo mudou: re-renderiza ícones e gráficos pra reajustar.
      this.$nextTick(() => { lucide.createIcons(); requestAnimationFrame(() => this.renderAllCharts()); });
    },

    toggleTheme() {
      this.theme = this.theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(`farejador_theme_${this.slug}`, this.theme); }
      catch (e) { /* localStorage indisponível: tema só nesta sessão */ }
      this.$nextTick(() => {
        lucide.createIcons();      // garante o ícone (sol/lua) renderizado após a troca
        this.renderAllCharts();    // canvas não reage a CSS: repinta os gráficos com a cor do tema novo
      });
    },

    init() {
      this.$nextTick(() => lucide.createIcons());
      if (this.apiToken) {
        this.authed = true;
        // Sessão pode ter expirado/sido revogada (validade de 30d). Se a carga
        // falhar com 401, volta pro login limpo em vez de travar numa tela vazia.
        this.$nextTick(async () => {
          try {
            await this.loadData();
            // Foto sob demanda: canal global (SSE + poll) vive desde já — o
            // alerta tem que tocar em QUALQUER aba, não só no Bate-papo.
            this.startPhotoGlobal();
            // PWA (0109): registra o ajudante de push + (re)inscreve o aparelho.
            // Quieto se o navegador não suportar ou o servidor estiver off.
            void this.initPush();
          } catch (err) {
            if (err && err.status === 401) {
              this.apiToken = '';
              localStorage.removeItem(this.tokenKey);
              this.authed = false;
            }
          }
        });
      }

      // Política de autoplay: o PRIMEIRO toque/clique em qualquer lugar destrava
      // o áudio do bip de foto (sem isso o navegador bloqueia som programático).
      document.addEventListener('pointerdown', () => this.unlockAudio(), { once: true });

      // Ordem da rota de entrega — salva neste aparelho (por unidade).
      try { this.routeOrder = JSON.parse(localStorage.getItem(`farejador_route_order_${this.slug}`) || '[]'); }
      catch (e) { this.routeOrder = []; }

      // Relogio do footer: re-renderiza a cada 30s.
      this.nowTimer = setInterval(() => { this.nowTick = Date.now(); }, 30000);

      // isMobile reativo: o Alpine decide as etapas do PDV; o CSS sozinho nao sabe (e o Alpine que controla o x-show).
      const mqMobile = window.matchMedia('(max-width: 768px)');
      this.isMobile = mqMobile.matches;
      mqMobile.addEventListener('change', (event) => {
        this.isMobile = event.matches;
        if (!event.matches) { this.posMobileStep = 'select'; this.orderMobileStep = 'list'; } // ao voltar pro desktop, zera as etapas
      });

      this.posKeydownHandler = (event) => {
        if (!this.authed || this.currentSection !== 'vendas') return;
        if (event.key === 'F2') {
          event.preventDefault();
          if (!this.saving) void this.posFinalizeSale();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          this.posClearCart();
          this.flash('Venda cancelada.');
        }
      };
      window.addEventListener('keydown', this.posKeydownHandler);

      // re-render charts on resize (debounced)
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (this.authed) this.renderAllCharts(); }, 160);
      });
    },

    get nowClockLabel() {
      // referencia nowTick pra forcar reatividade do Alpine
      this.nowTick;
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date());
    },

    get nowDateLabel() {
      this.nowTick;
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(new Date());
    },

    // â”€â”€â”€ API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    apiHeaders(hasBody = true) {
      const h = { Authorization: `Bearer ${this.apiToken}` };
      if (hasBody) h['Content-Type'] = 'application/json';
      return h;
    },

    async api(path, options = {}) {
      const hasBody = options.body !== undefined;
      const response = await fetch(`/parceiro/${this.slug}/api/${path}`, {
        ...options,
        headers: { ...this.apiHeaders(hasBody), ...(options.headers || {}) },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const err = new Error(payload.error || `api_${response.status}`);
        err.status = response.status;
        err.payload = payload;
        throw err;
      }
      return response.json();
    },

    async loadData() {
      if (!this.apiToken) return;
      this.loading = true;
      try {
        // Etapa 4: descobre o papel ANTES de carregar. Funcionário não pode
        // bater nos endpoints de financeiro (403) — /api/me é liberado pros dois.
        const me = await this.api('me');
        this.role = me.role === 'owner' ? 'owner' : 'funcionario';
        // Nome da loja logada (porta única 0095): com 1 conta abrindo N lojas, o topo
        // PRECISA dizer em qual unidade se está. Vem do servidor (ctx do token validado).
        this.unitName = me.unit_name || '';
        this.partnerName = me.partner_name || '';
        this.selfName = me.display_name || '';  // chip do topo (mata o "Caixa 01" chumbado)
        // permissions efetivo vem do servidor (gate §5.5); guardamos pra pintar o menu.
        if (me.permissions && typeof me.permissions === 'object') {
          this.permissions = { ...this.permissions, ...me.permissions };
        }
        // Se cair logado numa seção que não pode ver, manda pra uma tela permitida.
        if (!this.canSee(this.currentSection) && !['config'].includes(this.currentSection)) {
          this.currentSection = this.canSee('vendas') ? 'vendas' : (this.firstAllowedSection() || 'vendas');
        }

        // Carrega cada feed só se a tela é permitida (canSee), e tolera falha
        // individual: com requireScreen no backend, um feed proibido devolve 403 —
        // não pode derrubar o resto da tela. produtos é feed de APOIO (não-tela),
        // sempre carrega. Helper: pega .rows e engole erro pra não travar loadData.
        const safeRows = async (path) => {
          try { return (await this.api(path)).rows || []; }
          catch (err) { console.warn(`${path}_unavailable`, err); return []; }
        };
        const safeRow = async (path) => {
          try { const r = await this.api(path); return (r.rows && r.rows[0]) || null; }
          catch (err) { console.warn(`${path}_unavailable`, err); return null; }
        };

        const [produtos, vendas, retiradas, estoque, clientes] = await Promise.all([
          safeRows('produtos'),
          this.canSee('vendas') ? safeRows('vendas') : Promise.resolve([]),
          // Tela Retiradas tem feed próprio (guard requireScreen('retiradas')): o balconista
          // que só vê Retiradas carrega a fila SEM precisar da permissão de vendas.
          this.canSee('retiradas') ? safeRows('retiradas') : Promise.resolve([]),
          this.canSee('estoque') ? safeRows('estoque') : Promise.resolve([]),
          this.canSee('clientes') ? safeRows('clientes') : Promise.resolve([]),
        ]);
        this.produtos = produtos;
        this.vendas = vendas;
        this.retiradas = retiradas;
        this.estoque = estoque;
        this.clientes = clientes;

        // Resumo (tela Resumo) e Financeiro (caixa/contas) seguem a permissão
        // efetiva — o dono PODE ter liberado ao funcionário (PLANO §2.3). O resumo
        // alimenta KPIs das DUAS telas, então carrega pra qualquer uma das duas.
        if (this.canSee('resumo') || this.canSee('financeiro')) {
          this.resumo = await safeRow('resumo');
        }
        if (this.canSee('financeiro')) {
          const [compras, despesas, payables, receivables, fluxo] = await Promise.all([
            safeRows('compras'),
            safeRows('despesas'),
            safeRows('contas-a-pagar'),
            safeRows('contas-a-receber'),
            safeRow('fluxo-caixa'),
          ]);
          this.compras = compras;
          this.despesas = despesas;
          this.payables = payables;
          this.receivables = receivables;
          this.fluxoCaixa = fluxo;
          await this.loadCommissionTeam(); // #2 card Comissão da equipe (owner-only por dentro)
        }
        this.lastUpdatedAt = new Date();
        this.$nextTick(() => {
          lucide.createIcons();
          this.renderAllCharts();
        });
      } finally {
        this.loading = false;
      }
    },

    get currentSectionMeta() {
      const meta = {
        resumo: {
          title: 'Resumo',
          subtitle: 'Vis\u00e3o geral da opera\u00e7\u00e3o local',
        },
        vendas: {
          title: 'Frente de caixa',
          subtitle: 'Venda rápida, baixa de estoque e financeiro automático',
        },
        clientes: {
          title: 'Clientes',
          subtitle: 'Cadastro simples vinculado às vendas do parceiro',
        },
        estoque: {
          title: 'Estoque',
          subtitle: 'Cadastrar pneus e controlar saldo local',
        },
        financeiro: {
          title: 'Financeiro',
          subtitle: 'Compras, despesas e resultado simples',
        },
        batepapo: {
          title: 'Bate-papo',
          subtitle: 'Atendimento unificado WhatsApp, Instagram e Facebook',
        },
      };
      return meta[this.currentSection] || meta.resumo;
    },

    // â”€â”€â”€ NAVEGAÃ‡ÃƒO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    goToSection(id) {
      // Fase 1: Configurações segue só-dono (cadeado duro). Resumo/Financeiro e as
      // demais telas seguem a permissão efetiva (canSee). A trava real é o backend;
      // isto é só pra UI não ir pra uma tela vazia/proibida.
      if (id === 'config' && !this.isOwner) return;
      if (id !== 'config' && !this.canSee(id)) return;
      if (id === 'config') { this.loadConfiguracoes(); }
      if (id === 'pedidos') { this.resetOrderForm(); this.orderMobileStep = 'list'; }
      // Chat: liga o polling so quando a aba esta aberta; desliga ao sair (economiza requests).
      if (id === 'batepapo') this.startChatPolling();
      else this.stopChatPolling();
      // Abrir o chat recolhe o menu automaticamente pra dar espaço; o botão manual sempre manda.
      if (id === 'batepapo' && !this.sidebarCollapsed) {
        this.sidebarCollapsed = true;
        try { localStorage.setItem(`farejador_sidebar_collapsed_${this.slug}`, '1'); }
        catch (e) { /* localStorage indisponível */ }
      }
      this.currentSection = id;
      if (id === 'vendas') this.currentTab = 'sale';
      if (id === 'estoque') this.currentTab = 'stock';
      if (id === 'financeiro') this.currentTab = 'purchase';
      this.$nextTick(() => {
        const main = document.getElementById('partner-main');
        if (main) main.scrollTo({ top: 0, behavior: 'auto' });
        lucide.createIcons();
        requestAnimationFrame(() => this.renderAllCharts());
        if (id === 'batepapo') this.scrollChatToEnd();
      });
    },
});
