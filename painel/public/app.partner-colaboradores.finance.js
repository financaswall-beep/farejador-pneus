// Subaba financeira da equipe parceira. Os valores continuam vindo do mesmo
// contrato de equipe e a gravação usa o endpoint transacional de configuração.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerColaboradoresFinance = function () {
  return {
    partnerColaboradoresSetTab(tab) {
      const state = this.partnerColaboradores;
      if (!['equipe', 'remuneracao'].includes(tab)) return;
      state.tab = tab;
      state.notice = '';
      if (tab === 'equipe') state.selected = null;
      else if (!state.selected) {
        const first = state.rows.find((row) => row.active);
        if (first) this.partnerColaboradoresOpen(first);
      }
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    partnerColaboradoresRemunerationRows() {
      const state = this.partnerColaboradores;
      const query = String(state.q || '').trim().toLocaleLowerCase('pt-BR');
      return state.rows.filter((row) => {
        if (!row.active) return false;
        if (state.remunerationFilter === 'configured' && !row.compensation_starts_on) return false;
        if (state.remunerationFilter === 'pending' && row.compensation_starts_on) return false;
        return !query || [row.name, row.label, row.username, row.role]
          .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(query);
      });
    },
    partnerColaboradoresMonthlyBase(row) {
      const base = Number(row?.base_salary || 0);
      return row?.salary_frequency === 'weekly' ? Math.round(base * 52 / 12 * 100) / 100 : base;
    },
    partnerColaboradoresMonthlySalaryTotal() {
      return this.partnerColaboradores.rows.filter((row) => row.active)
        .reduce((sum, row) => sum + this.partnerColaboradoresMonthlyBase(row), 0);
    },
    partnerColaboradoresFinancialTotal(row) {
      return this.partnerColaboradoresMonthlyBase(row) + Number(row?.benefits_total || 0)
        + Number(row?.commission_amount || 0);
    },
    partnerColaboradoresSelectedTotal() {
      const state = this.partnerColaboradores;
      const compensation = state.detail.compensation;
      const rawBase = Number(compensation.base_salary || 0);
      const base = compensation.salary_frequency === 'weekly'
        ? Math.round(rawBase * 52 / 12 * 100) / 100 : rawBase;
      const benefits = compensation.benefits.reduce((sum, item) => (
        item.active === false ? sum : sum + Number(item.amount || 0)
      ), 0);
      return base + benefits + Number(state.selected?.commission_amount || 0);
    },
    partnerColaboradoresCommissionLabel(row) {
      if (!row?.commission_active || !row.commission_kind) return 'Sem comissão';
      return row.commission_kind === 'fixed'
        ? `${this.formatCurrency(row.commission_value)} por venda`
        : `${Number(row.commission_value || 0).toLocaleString('pt-BR')}% sobre vendas`;
    },
    partnerColaboradoresEmploymentLabel(value) {
      return ({ clt: 'CLT', mei: 'MEI', autonomo: 'Autônomo', outro: 'Outro' })[value] || 'Não configurado';
    },
    partnerColaboradoresCancelFinancialEdit() {
      this.partnerColaboradores.selected = null;
      this.partnerColaboradores.detailError = null;
    },
  };
};
