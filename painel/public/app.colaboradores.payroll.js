window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.colaboradoresPayroll = function () {
  return {
    get colabFolhaRows() {
      return this.colaboradores.filter((c) => c.payroll_item_id || (c.active && (c.employment_type || c.commission_active || c.additions || c.deductions)));
    },
    get colabFolhaPodeFechar() {
      return this.colabSummary.payroll_period_status === 'preview'
        && this.colabMes < this.colabCurrentMonth
        && Number(this.colabSummary.payroll_review_count || 0) === 0
        && this.colabFolhaRows.length > 0;
    },
    colabFolhaBenefits(c) {
      const frozen = c?.payroll_calculation?.recurring_benefits;
      if (!Array.isArray(frozen)) return Number(c?.benefits_total || 0);
      return frozen.reduce((sum, benefit) => sum + Number(benefit?.amount || 0), 0);
    },
    colabFolhaManualAdditions(c) {
      return Math.max(0, Number(c?.additions || 0) - this.colabFolhaBenefits(c));
    },
    colabFolhaAdjustmentLabel(c) {
      const additions = this.colabFolhaManualAdditions(c);
      const deductions = Number(c?.deductions || 0);
      if (!additions && !deductions) return '—';
      return `${additions ? `+ ${this.formatCurrency(additions)}` : ''}${additions && deductions ? ' · ' : ''}${deductions ? `− ${this.formatCurrency(deductions)}` : ''}`;
    },
    colabFolhaHistoryLabel(row) {
      const value = String(row?.competence || '').slice(0, 7);
      const [year, month] = value.split('-').map(Number);
      if (!year || !month) return 'Competência';
      return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' })
        .format(new Date(Date.UTC(year, month - 1, 1)));
    },
    colabFolhaPeriodStatusLabel(status) {
      return ({ closed: 'Em aberto', partial: 'Parcialmente paga', paid: 'Paga' })[status] || 'Fechada';
    },
    colabFolhaPeriodStatusClass(status) {
      return status === 'paid' ? 'bg-emerald-50 text-emerald-700'
        : status === 'partial' ? 'bg-sky-50 text-sky-700' : 'bg-gray-100 text-gray-600';
    },
    colabFolhaClosedAt(row) {
      return row?.closed_at ? this.formatDateTime(row.closed_at) : '—';
    },
    async colabFolhaOpenHistory(row) {
      const competence = String(row?.competence || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(competence)) return;
      this.colabMes = competence;
      await this.colabMesMudou();
    },
    colabFolhaGoFinanceiro() {
      this.currentPage = 'financeiro';
      this.finOpenTab('pagar');
    },
    colabFolhaReviewPendencies() {
      const adjustment = this.colabAdjustments.find((row) => row.causal_status === 'needs_review');
      if (adjustment) {
        const collaborator = this.colaboradores.find((row) => row.id === adjustment.collaborator_id);
        if (collaborator) this.colabOpen(collaborator, 'folha');
        return;
      }
      const reasons = this.colabSummary.payroll_review_reasons || {};
      if (Number(reasons.unresolved_costs || 0) > 0) {
        this.colabMsg = { ok: false, text: 'Há venda com custo desconhecido afetando comissão por margem. Corrija o custo no Estoque antes de fechar.' };
      } else if (Number(reasons.unassigned_events || 0) > 0) {
        this.colabMsg = { ok: false, text: 'Há vendas, entregas ou rotas comissionáveis sem colaborador atribuído. Corrija o responsável na operação antes de fechar.' };
      }
    },
  };
};
