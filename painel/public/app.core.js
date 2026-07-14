// Obra 300 (2026-07-05): fatia do painel da MATRIZ — encanamento: loadRealData/loadRedeData/init/live refresh.
// VERBATIM das linhas 2249-2419 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.core = function () {
  return {
    async loadRealData() {
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      this.loadApplications(); // Etapa 3: badge de candidaturas (não bloqueia o resto)

      // Promise.allSettled: cada bloco é independente — um endpoint que falhe
      // não derruba os outros pro mock. Resumo = bot/tráfego (matriz-resumo,
      // analytics read-only) + cobrança (rede). Rede = operação dos parceiros.
      const [pedidos, produtos, rede, resumo] = await Promise.allSettled([
        this.apiGet('/admin/api/dashboard/pedidos?limit=50'),
        this.apiGet('/admin/api/dashboard/produtos?limit=100'),
        this.apiGet(`/admin/api/dashboard/rede?period=${encodeURIComponent(this.redePeriod)}`),
        this.apiGet('/admin/api/dashboard/matriz-resumo?period=7d'),
      ]);

      const val = (settled) => (settled.status === 'fulfilled' ? settled.value : null);
      const settledList = [pedidos, produtos, rede, resumo];
      const ok = settledList.map(val).filter(Boolean);

      this.serverEnvironment = ok.map((r) => r.environment).find(Boolean) || this.serverEnvironment;
      this.chatwootBaseUrl = ok.map((r) => r.chatwoot_base_url).find(Boolean) || this.chatwootBaseUrl;
      this.chatwootAccountId = ok.map((r) => r.chatwoot_account_id).find(Boolean) || this.chatwootAccountId;
      const workerFlag = ok.map((r) => r.agent_v2_worker_enabled).find((v) => v !== undefined && v !== null);
      if (workerFlag !== undefined) this.agentV2WorkerEnabled = workerFlag;

      if (val(pedidos)) this.applyPedidos(pedidos.value.rows);
      if (val(produtos)) this.applyProdutos(produtos.value.rows);
      if (val(rede)) this.applyRede(rede.value.rows);
      if (val(resumo)) this.applyMatrizResumo(resumo.value);

      // "real" se qualquer bloco respondeu; só cai pro mock se TUDO falhou.
      if (ok.length > 0) {
        this.apiStatus = 'real';
        this.apiError = null;
      } else {
        this.apiStatus = 'mock';
        const firstErr = settledList.find((s) => s.status === 'rejected');
        this.apiError = firstErr && firstErr.reason
          ? (firstErr.reason instanceof Error ? firstErr.reason.message : String(firstErr.reason))
          : 'todos os endpoints falharam';
        console.warn('Painel usando dados mockados:', this.apiError);
      }
    },

    async loadRedeData() {
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;

      try {
        const rede = await this.apiGet(`/admin/api/dashboard/rede?period=${encodeURIComponent(this.redePeriod)}`);
        this.serverEnvironment = rede.environment || this.serverEnvironment;
        this.chatwootBaseUrl = rede.chatwoot_base_url || this.chatwootBaseUrl;
        this.chatwootAccountId = rede.chatwoot_account_id || this.chatwootAccountId;
        this.applyRede(rede.rows);
        this.apiStatus = 'real';
        this.apiError = null;
        this.$nextTick(() => {
          lucide.createIcons();
          this.renderRedeChart();
          this.renderRedeLucroChart();
          this.renderRedeComprasChart();
          this.renderEstoqueParadoChart();
          this.renderMargemChart();
          this.renderVendaHojeChart();
          this.renderPneusRedeChart();
          this.renderRedeOrigemChart();
          this.renderRedeSaudeChart();
        });
      } catch (err) {
        this.apiStatus = 'mock';
        this.apiError = err instanceof Error ? err.message : String(err);
      }
    },

    async init() {
      if (!(await this.ensureCredentials())) return;
      void this.loadRealData();
      // Livro de comissões já no boot: o card "A receber da rede" do RESUMO lê ele
      // (flag off = resposta enabled:false, barata; a página Rede re-varre ao entrar).
      void this.loadComissoes();
      // Sino (2026-07-06): notificações reais já no boot.
      void this.loadSino();
      // Campainha do bot (2026-07-06): cliente esperando é alarme — badge já no boot.
      void this.loadBotCampainha();
      this.$nextTick(() => {
        lucide.createIcons();
        this.renderChart();
        this.renderRedeChart();
        this.renderRedeLucroChart();
        this.renderRedeComprasChart();
        this.renderEstoqueParadoChart();
        this.renderMargemChart();
        this.renderVendaHojeChart();
        this.renderPneusRedeChart();
        this.renderRedeOrigemChart();
        this.renderRedeSaudeChart();
        this.renderParceiroChart();
      });

      this.$watch('currentPage', (page) => {
        this.$nextTick(() => {
          lucide.createIcons();
          this.renderCurrentPageCharts();
        });
        // Compras é tela própria: carrega fornecedor/compra/ranking ao entrar.
        if (page === 'compras') void this.loadAtacado();
        // Estoque é tela própria: o galpão saiu de Vendas → Atacado, mas o dado é o mesmo.
        // O filme (0128) carrega junto — é a mesma visita à aba.
        if (page === 'estoque') { void this.loadAtacado(); void this.loadGalpaoFilme(); }
        // Logística (0121): entregas da matriz + rota do dia do entregador.
        if (page === 'logistica') void this.loadLogistica();
        // Vendas: visão comercial unificada; custos e lucro permanecem no Financeiro.
        if (page === 'vendas') void this.loadVendasData();
        // Rede: o livro de comissões (0118) — o GET roda a varredura no servidor.
        if (page === 'rede') void this.loadComissoes();
        // Colaboradores (0124): o staff da matriz — vendedor/entregador.
        if (page === 'colaboradores') void this.loadColaboradores();
        // Financeiro: visão consolidada (Onda 1) + despesas (0120) num carregador só.
        if (page === 'financeiro') void this.loadFinanceiro();
        // Bot (2026-07-06): visão (cards/mapa/radar) ao entrar na aba.
        if (page === 'bot') void this.loadBotVisao();
      });

      this.startLiveRefresh();
    },

    renderCurrentPageCharts() {
      if (this.currentPage === 'resumo') this.renderChart();
      if (this.currentPage === 'rede') {
        this.renderRedeChart();
        this.renderRedeLucroChart();
        this.renderRedeComprasChart();
        this.renderEstoqueParadoChart();
        this.renderMargemChart();
        this.renderVendaHojeChart();
        this.renderPneusRedeChart();
        this.renderRedeOrigemChart();
        this.renderRedeSaudeChart();
        this.renderParceiroChart();
      }
      if (this.currentPage === 'unidade') this.renderParceiroChart();
    },

    // Atualização near real-time: a cada 15s rebusca os dados das telas vivas
    // (rede + resumo + pedidos) e re-renderiza, sem F5. Silencioso em erro
    // (mantém o último dado bom). Pausa quando a aba do navegador está oculta.
    startLiveRefresh() {
      if (this.liveRefreshId) return;
      this.liveRefreshId = setInterval(() => { void this.liveRefresh(); }, 15000);
    },

    async liveRefresh() {
      if (this.liveRefreshing || document.hidden) return;
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      // Sino atualiza em QUALQUER página (aviso é aviso); tem try/catch próprio.
      void this.loadSino();
      // Campainha do bot idem: cliente esperando não pode depender da aba aberta.
      void this.loadBotCampainha();
      if (!['resumo', 'rede', 'unidade', 'vendas'].includes(this.currentPage)) return;

      this.liveRefreshing = true;
      try {
        const [rede, resumo, pedidos] = await Promise.allSettled([
          this.apiGet(`/admin/api/dashboard/rede?period=${encodeURIComponent(this.redePeriod)}`),
          this.apiGet('/admin/api/dashboard/matriz-resumo?period=7d'),
          this.apiGet('/admin/api/dashboard/pedidos?limit=50'),
        ]);
        if (rede.status === 'fulfilled') this.applyRede(rede.value.rows);
        if (resumo.status === 'fulfilled') this.applyMatrizResumo(resumo.value);
        if (pedidos.status === 'fulfilled') this.applyPedidos(pedidos.value.rows);
        if ([rede, resumo, pedidos].some((r) => r.status === 'fulfilled')) {
          this.apiStatus = 'real';
          this.apiError = null;
          this.$nextTick(() => { lucide.createIcons(); this.renderCurrentPageCharts(); });
        }
      } catch (err) {
        /* silencioso: mantém o último dado bom na tela */
      } finally {
        this.liveRefreshing = false;
      }
    },

    // ─── GRÁFICO ────────────────────────────────────
  };
};
