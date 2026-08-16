/**
 * app.config.equipe.js — Bloco 2 (2026-06-12): ACESSO + COMISSÃO por PESSOA no drawer
 * do funcionário (aba Equipe). Carrega o config do funcionário selecionado e grava
 * permissões, remuneração e comissão nas mesmas APIs usadas pelo app Operação.
 * O ESTADO (funcConfigLoaded/funcPermForm/funcRemForm/funcCommForm) mora
 * na raiz (app.js). REGRA: teto 300 (npm run checar-tamanho); `this` é o objeto de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.configEquipe = () => ({
  // Bate-papo foi aposentado; as oito permissões abaixo refletem os portais atuais.
  get funcPermCount() {
    const keys = ['vendas', 'estoque', 'pedidos', 'clientes', 'entregas', 'retiradas', 'resumo', 'financeiro'];
    return keys.reduce((n, k) => n + (this.funcPermForm && this.funcPermForm[k] ? 1 : 0), 0);
  },

  // Carrega telas + comissão do funcionário aberto (GET .../config). Chamado pelo
  // selectFuncionario (config.js). Funcionário desativado não carrega (some o painel).
  async loadFuncConfig(f) {
    this.funcConfigLoaded = false;
    if (!f || !f.id || f.revoked_at) return;
    try {
      const [perm, rem, comm] = await Promise.all([
        this.api(`equipe/${f.id}/permissoes`), this.api(`equipe/${f.id}/remuneracao`),
        this.api(`equipe/${f.id}/comissao`),
      ]);
      const p = perm.permissions || {};
      this.funcPermForm = {
        vendas: !!p.vendas, estoque: !!p.estoque, pedidos: !!p.pedidos, clientes: !!p.clientes,
        entregas: !!p.entregas, retiradas: !!p.retiradas, batepapo: false,
        resumo: !!p.resumo, financeiro: !!p.financeiro,
      };
      this.funcPermLocked = !!perm.locked;
      this.funcRemForm = {
        employment_type: rem.employment_type || 'clt', base_salary: Number(rem.base_salary || 0),
        salary_frequency: rem.salary_frequency || 'monthly', payment_day: Number(rem.payment_day || 5),
        payment_method: rem.payment_method || 'pix', starts_on: String(rem.starts_on || '').slice(0, 10),
        benefits: JSON.parse(JSON.stringify(rem.benefits || [])),
      };
      const c = comm || {};
      this.funcCommForm = {
        kind: c.kind === 'fixed' ? 'fixed' : 'percent',
        basis: c.kind === 'fixed' ? 'sale' : 'revenue',
        value: (c.value !== undefined && c.value !== null) ? Number(c.value) : 0,
        active: !!c.active, starts_on: String(c.starts_on || rem.starts_on || '').slice(0, 10),
        settlement_frequency: c.settlement_frequency || 'monthly',
        itemized: !!c.itemized,
        item_rules: JSON.parse(JSON.stringify(c.item_rules || { tire: { kind: 'none', value: 0 }, service: { kind: 'none', value: 0 }, other: { kind: 'none', value: 0 } })),
      };
      this.funcConfigLoaded = true;
      this.$nextTick(() => lucide.createIcons());
    } catch (err) {
      console.warn('func_config_unavailable', err);
      this.flash(this.errMessage(err));
    }
  },

  addFuncBenefit() {
    if (this.funcRemForm.benefits.length < 12) this.funcRemForm.benefits.push({ name: '', amount: 0, active: true });
  },
  removeFuncBenefit(index) { this.funcRemForm.benefits.splice(index, 1); },

  // Salva permissões, remuneração e comissão no mesmo modelo do app.
  async saveFuncConfig(f) {
    if (!f || !f.id) return;
    // Comissão ligada exige valor > 0 (senão é "ativa" pagando zero — confunde).
    if (this.funcCommForm.active && !this.funcCommForm.itemized) {
      const v = Number(this.funcCommForm.value);
      if (!Number.isFinite(v) || v <= 0) { this.flash('Informe o valor da comissão (maior que zero) ou desligue a comissão.'); return; }
      if (this.funcCommForm.kind === 'percent' && v > 100) { this.flash('Comissão em % não pode passar de 100.'); return; }
    }
    this.saving = true; this.savingAction = 'funcConfig';
    try {
      await this.api(`equipe/${f.id}/permissoes`, {
        method: 'PUT',
        body: JSON.stringify({
          vendas: !!this.funcPermForm.vendas, estoque: !!this.funcPermForm.estoque,
          pedidos: !!this.funcPermForm.pedidos, clientes: !!this.funcPermForm.clientes,
          entregas: !!this.funcPermForm.entregas, retiradas: !!this.funcPermForm.retiradas,
          batepapo: false, resumo: !!this.funcPermForm.resumo,
          financeiro: !!this.funcPermForm.financeiro,
        }),
      });
      await this.api(`equipe/${f.id}/remuneracao`, {
        method: 'PUT', body: JSON.stringify({
          ...this.funcRemForm, base_salary: Number(this.funcRemForm.base_salary || 0),
          payment_day: Number(this.funcRemForm.payment_day || 5),
          benefits: this.funcRemForm.benefits.filter((item) => String(item.name || '').trim()).map((item) => ({
            name: String(item.name).trim(), amount: Number(item.amount || 0), active: item.active !== false,
          })),
        }),
      });
      await this.api(`equipe/${f.id}/comissao`, {
        method: 'PUT',
        body: JSON.stringify({
          kind: this.funcCommForm.kind === 'fixed' ? 'fixed' : 'percent',
          basis: this.funcCommForm.kind === 'fixed' ? 'sale' : 'revenue',
          value: this.funcCommForm.active ? Number(this.funcCommForm.value) : 0,
          active: !!this.funcCommForm.active, starts_on: this.funcCommForm.starts_on || this.funcRemForm.starts_on,
          settlement_frequency: this.funcCommForm.settlement_frequency,
          itemized: !!this.funcCommForm.itemized, item_rules: this.funcCommForm.item_rules,
        }),
      });
      this.flash('Acesso, remuneração e comissão salvos.', 'success');
    } catch (err) {
      this.flash(this.errMessage(err));
    } finally {
      this.saving = false; this.savingAction = '';
    }
  },
});
