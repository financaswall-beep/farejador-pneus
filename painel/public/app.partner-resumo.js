// Resumo moderno da unidade: apresenta apenas agregados calculados no servidor.
// Não refaz lucro, caixa, custo ou comissão no navegador.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerResumo = function () {
  return {
    partnerResumoData: null,
    partnerResumoTeam: { rows: [], total_commission: 0 },
    partnerResumoSelf: null,
    partnerResumoLoading: false,
    partnerResumoError: '',
    partnerResumoUpdatedAt: null,

    async loadPartnerResumo() {
      if (!this.isPartnerPanel() || !this.hasPanelModule('resumo')) return;
      this.partnerResumoLoading = true;
      this.partnerResumoError = '';
      const [summary, team, self] = await Promise.allSettled([
        this.partnerApiGet('resumo'),
        this.partnerApiGet('comissao/equipe'),
        this.partnerApiGet('meu-desempenho'),
      ]);
      if (summary.status === 'fulfilled') {
        this.partnerResumoData = summary.value.rows?.[0] || null;
        this.partnerResumoUpdatedAt = new Date().toISOString();
      } else {
        this.partnerResumoData = null;
        this.partnerResumoError = 'Não foi possível carregar o resumo da unidade.';
      }
      this.partnerResumoTeam = team.status === 'fulfilled'
        ? team.value : { rows: [], total_commission: 0 };
      this.partnerResumoSelf = self.status === 'fulfilled' ? self.value : null;
      this.partnerResumoLoading = false;
      this.$nextTick(() => { lucide.createIcons(); });
    },

    partnerResumoNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    },

    get partnerResumoHasPendingCost() {
      return this.partnerResumoNumber(this.partnerResumoData?.pending_cost_items_month) > 0;
    },

    get partnerResumoTeamRows() {
      return Array.isArray(this.partnerResumoTeam?.rows)
        ? this.partnerResumoTeam.rows.slice(0, 5) : [];
    },

    partnerResumoMonthLabel() {
      return new Intl.DateTimeFormat('pt-BR', {
        month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo',
      }).format(new Date());
    },
  };
};
