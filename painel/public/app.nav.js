// Obra 300 (2026-07-05): fatia do painel da MATRIZ — título/menu/badge + seleção de unidade (abrir/voltar).
// VERBATIM das linhas 208-262 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

window.PAINEL_MENU_ITEMS = Object.freeze([
  { id: 'resumo', label: 'Resumo', icon: 'layout-dashboard', requires: 'resumo' },
  { id: 'bot', label: 'Bot', icon: 'bot', requires: 'bot' },
  { id: 'vendas', label: 'Vendas', icon: 'shopping-bag', requires: 'vendas' },
  { id: 'clientes', label: 'Clientes', icon: 'users', requires: 'clientes' },
  { id: 'compras', label: 'Compras', icon: 'shopping-cart', requires: 'compras' },
  { id: 'estoque', label: 'Estoque', icon: 'package', requires: 'estoque' },
  { id: 'logistica', label: 'Logística', icon: 'truck', requires: 'logistica' },
  { id: 'financeiro', label: 'Financeiro', icon: 'wallet', requires: 'financeiro' },
  { id: 'rede', label: 'Rede', icon: 'network', requires: 'rede' },
  { id: 'marketing', label: 'Marketing', icon: 'megaphone', requires: 'marketing' },
  { id: 'colaboradores', label: 'Colaboradores', icon: 'users', requires: 'colaboradores' },
  { id: 'catalogo', label: 'Catálogo', icon: 'tag', requires: 'catalogo' },
]);

// Registro único do ciclo de vida das páginas. As telas do parceiro acrescentam
// seus handlers nos PRs próprios, sem criar outro watcher ou outro encanamento.
window.PAINEL_PAGES = {
  resumo: { scopes: ['matrix', 'partner'], requires: 'resumo', partnerLoad: ['loadPartnerResumo'] },
  rede: { scopes: ['matrix'], requires: 'rede', load: ['loadComissoes'], render: [
    'renderRedeChart', 'renderRedeLucroChart', 'renderRedeComprasChart',
    'renderEstoqueParadoChart', 'renderMargemChart', 'renderVendaHojeChart',
    'renderPneusRedeChart', 'renderRedeOrigemChart', 'renderRedeSaudeChart',
    'renderParceiroChart',
  ] },
  unidade: { scopes: ['matrix'], requires: 'rede', render: ['renderParceiroChart'] },
  vendas: { scopes: ['matrix'], requires: 'vendas', load: ['loadVendasData'] },
  clientes: { scopes: ['matrix'], requires: 'clientes', load: ['loadClientes'], enter: ['startClientesLive'] },
  compras: { scopes: ['matrix'], requires: 'compras', load: ['loadCompras'] },
  estoque: { scopes: ['matrix'], requires: 'estoque', load: [
    'loadAtacado', 'loadGalpaoFilme', 'loadStockReconciliation',
  ] },
  logistica: { scopes: ['matrix'], requires: 'logistica', load: ['loadLogistica'] },
  financeiro: { scopes: ['matrix'], requires: 'financeiro', load: ['loadFinanceiro', 'loadFinExtrato'] },
  bot: { scopes: ['matrix'], requires: 'bot', load: ['loadBotVisao', 'loadBotMovement'] },
  marketing: { scopes: ['matrix'], requires: 'marketing', load: ['loadMarketing'] },
  colaboradores: { scopes: ['matrix'], requires: 'colaboradores', load: ['loadColaboradores'] },
  catalogo: { scopes: ['matrix'], requires: 'catalogo', load: ['loadCatalogo'] },
};

window.PAINEL_MODULES.nav = function () {
  return {
    get liveMenu() {
      const enabled = new Set(this.panelModules || []);
      return window.PAINEL_MENU_ITEMS
        .filter((item) => enabled.has(item.requires) && this.panelPageEnabled(item.id))
        .map((item) => ({ ...item, badge: this.menuBadges?.[item.id] || null }));
    },

    isMatrixPanel() {
      return this.panelScope === 'matrix';
    },

    isPartnerPanel() {
      return this.panelScope === 'partner';
    },

    hasPanelModule(module) {
      return Array.isArray(this.panelModules) && this.panelModules.includes(module);
    },

    panelPageEnabled(pageId) {
      const page = window.PAINEL_PAGES[pageId];
      return !!page && page.scopes.includes(this.panelScope) && this.hasPanelModule(page.requires);
    },

    firstPanelPage() {
      return this.liveMenu[0]?.id || null;
    },

    currentPageTitle() {
      const all = [...this.liveMenu, ...this.futureMenu];
      return all.find(i => i.id === this.currentPage)?.label || '';
    },

    notifBadgeCount() {
      return this.notificacoes.filter(n => !n.read).length;
    },

    selectedParceiro() {
      return this.parceirosRede[this.selectedParceiroIndex] || this.parceirosRede[0] || null;
    },

    selectParceiro(index) {
      this.selectedParceiroIndex = index;
      this.$nextTick(() => {
        lucide.createIcons();
        this.renderParceiroChart();
      });
    },

    openParceiroDetalhe(index) {
      this.selectedParceiroIndex = index;
      this.unidadeTab = 'visao';
      this.currentPage = 'unidade';
      this.$nextTick(() => {
        document.querySelector('main')?.scrollTo(0, 0);
        lucide.createIcons();
        this.renderParceiroChart();
      });
    },

    setUnidadeTab(tab) {
      this.unidadeTab = tab;
      this.$nextTick(() => {
        lucide.createIcons();
        if (tab === 'visao') this.renderParceiroChart();
      });
    },

    setRedeSection(section) {
      this.redeSection = section;
      this.$nextTick(() => {
        lucide.createIcons();
        if (section === 'visao') {
          this.renderRedeChart();
          this.renderRedeOrigemChart();
        }
        if (section === 'operacao' && this.redeOperacaoLegadaAtiva()) {
          this.renderRedeComprasChart();
          this.renderPneusRedeChart();
          this.renderRedeSaudeChart();
          this.renderEstoqueParadoChart();
          this.renderMargemChart();
          this.renderVendaHojeChart();
        }
      });
    },

    voltarParaRede() {
      this.currentPage = 'rede';
      this.$nextTick(() => {
        document.querySelector('main')?.scrollTo(0, 0);
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
    },

  };
};
