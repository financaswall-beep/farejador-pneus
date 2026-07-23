// Obra 300 (2026-07-05): fatia do painel da MATRIZ — título/menu/badge + seleção de unidade (abrir/voltar).
// VERBATIM das linhas 208-262 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.nav = function () {
  return {
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
        if (section === 'operacao') {
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
