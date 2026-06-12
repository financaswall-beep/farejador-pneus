/**
 * app.comissao.js — Bloco 2, telas #2 e #3 (2026-06-12):
 *   #2 "Comissão da equipe" (card do DONO no Financeiro) — GET comissao/equipe.
 *   #3 "Meu desempenho" (modal pelo chip do topo) — GET meu-desempenho (self, ctx.tokenId).
 * Backend já no ar (commit 0474e03). O ESTADO (selfName/commissionTeam/perfOpen/perf)
 * mora na raiz (app.js). REGRA: teto 300 (npm run checar-tamanho); `this` é o app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.comissao = () => ({
  // ─── #2: Comissão da equipe (dono) ───
  async loadCommissionTeam() {
    if (!this.isOwner) return; // endpoint é owner-only (funcionário levaria 403)
    try {
      const res = await this.api('comissao/equipe');
      this.commissionTeam = { rows: res.rows || [], total_commission: res.total_commission || 0 };
    } catch (err) {
      console.warn('comissao_equipe_unavailable', err);
    }
  },

  // Rótulo da config de comissão de uma linha (% ou R$ por venda; ou "sem comissão").
  commLabel(r) {
    if (!r || !r.commission_active || !Number(r.commission_value)) return 'sem comissão';
    return r.commission_kind === 'fixed'
      ? ('R$ ' + Number(r.commission_value).toFixed(2).replace('.', ',') + '/venda')
      : (String(Number(r.commission_value)).replace('.', ',') + '% por venda');
  },

  // ─── #3: Meu desempenho (qualquer logado vê o PRÓPRIO) ───
  async openMeuDesempenho() {
    this.perfOpen = true;
    this.perf = null; // estado de carregando
    try {
      this.perf = await this.api('meu-desempenho');
    } catch (err) {
      this.flash(this.errMessage(err));
      this.perfOpen = false;
      return;
    }
    this.$nextTick(() => lucide.createIcons());
  },
  closeMeuDesempenho() { this.perfOpen = false; },

  // Canal da venda (balcão x robô) e status legível, pra lista do desempenho.
  perfCanal(s) { return s && s.canal === '2w' ? 'Robô (2W)' : 'Balcão'; },
  perfStatus(s) {
    if (!s) return '';
    if (s.fulfillment_mode === 'delivery') return s.status === 'paid' ? 'Entregue' : 'A confirmar';
    if (s.fulfillment_mode === 'pickup') return s.status === 'paid' ? 'Retirado' : 'A confirmar';
    return 'Concluída';
  },
});
