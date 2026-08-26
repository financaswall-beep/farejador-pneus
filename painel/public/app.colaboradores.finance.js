// Tela unificada de remuneração e comissões da Matriz. A Folha continua sendo
// a única responsável por fechar competência e criar o título no Financeiro.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.colaboradoresFinance = function () {
  return {
    get colabFinancialRows() {
      return this.colabRemuneracaoRows;
    },
    colabMonthlyBase(c) {
      const base = Number(c?.monthly_base_salary ?? c?.base_salary ?? 0);
      return c?.salary_frequency === 'weekly'
        ? Math.round(base * 52 / 12 * 100) / 100 : base;
    },
    get colabMonthlySalaryTotal() {
      return this.colabAtivos.reduce((sum, c) => sum + this.colabMonthlyBase(c), 0);
    },
    colabFinancialTotal(c) {
      return this.colabMonthlyBase(c) + Number(c?.benefits_total || 0)
        + Number(c?.commission_amount || 0);
    },
    colabOpenFinancial(c) {
      this.colabOpen(c, 'financeiro-inline');
    },
    colabCancelFinancialEdit() {
      if (this.colabSaving) return;
      this.colabSelectedId = null;
      this.colabMsg = null;
    },
    colabSelectedFinancialTotal() {
      const rawBase = this.colabNumber(this.colabRemForm.base_salary);
      const base = this.colabRemForm.salary_frequency === 'weekly'
        ? Math.round(rawBase * 52 / 12 * 100) / 100 : rawBase;
      const benefits = this.colabRemForm.benefits.reduce((sum, item) => (
        item.active === false ? sum : sum + this.colabNumber(item.amount)
      ), 0);
      return base + benefits + Number(this.colabSelected?.commission_amount || 0);
    },
    async colabSalvarConfiguracaoFinanceira() {
      const c = this.colabSelected;
      if (!c || this.colabSaving) return;
      const commission = this.colabComForm;
      if (commission.active && !commission.itemized && !(this.colabNumber(commission.value) > 0)) {
        this.colabMsg = { ok: false, text: 'Informe o valor da comissão ou desative-a.' };
        return;
      }
      this.colabSaving = true;
      this.colabMsg = null;
      try {
        await this.apiPost('/admin/api/colaboradores/configuracao-financeira', {
          compensation: {
            collaborator_id: c.id, ...this.colabRemForm,
            base_salary: this.colabNumber(this.colabRemForm.base_salary),
            payment_note: this.colabRemForm.payment_note.trim() || null,
            benefits: this.colabRemForm.benefits.filter((item) => item.name.trim()).map((item) => ({
              name: item.name.trim(), amount: this.colabNumber(item.amount), active: item.active !== false,
            })),
          },
          commission: {
            collaborator_id: c.id, ...commission,
            value: commission.active ? this.colabNumber(commission.value) : 0,
            item_rules: Object.fromEntries(Object.entries(commission.item_rules).map(([key, rule]) => [key, {
              kind: rule.kind, value: this.colabNumber(rule.value),
            }])),
          },
        });
        this.colabMsg = { ok: true, text: `Remuneração e comissão de ${c.display_name} salvas.` };
        await this.loadColaboradores();
      } catch (err) {
        this.colabMsg = { ok: false, text: `Não consegui salvar (${err.message}).` };
      } finally {
        this.colabSaving = false;
      }
    },
  };
};
