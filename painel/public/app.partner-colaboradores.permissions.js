// Gestão visual das permissões reais do parceiro. A autorização continua no
// servidor; os modelos são apenas atalhos de preenchimento da allowlist.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerColaboradoresPermissions = function () {
  const keys = [
    'vendas', 'estoque', 'pedidos', 'clientes', 'entregas',
    'retiradas', 'batepapo', 'resumo', 'financeiro',
    'compras', 'colaboradores', 'catalogo',
  ];
  // Toda permissão efetiva precisa aparecer no editor. Ocultar chaves aqui
  // deixava pedidos, clientes e bate-papo ativos sem o proprietário enxergar.
  const visibleKeys = [...keys];
  return {
    partnerColaboradoresVisiblePermissionKeys() { return visibleKeys; },
    partnerColaboradoresPermissionRows() { return this.partnerColaboradoresFiltered(); },
    partnerColaboradoresPermissionCountLabel(row) {
      const allowed = new Set(visibleKeys);
      return `${Object.entries(row?.permissions || {})
        .filter(([key, enabled]) => allowed.has(key) && enabled).length} módulos`;
    },
    partnerColaboradoresWithoutPanelAccess() {
      return this.partnerColaboradores.rows.filter((row) => !row.active).length;
    },
    partnerColaboradoresUnusedAccessCount() {
      const limit = Date.now() - (30 * 24 * 60 * 60 * 1000);
      return this.partnerColaboradores.rows.filter((row) => row.active && row.last_used_at
        && new Date(row.last_used_at).getTime() < limit).length;
    },
    partnerColaboradoresLastAccess(row) {
      if (!row?.last_used_at) return 'Nunca acessou';
      const date = new Date(row.last_used_at);
      if (Number.isNaN(date.getTime())) return 'Nunca acessou';
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
      }).format(date);
    },
    partnerColaboradoresPermissionMeta(key) {
      return ({
        resumo: ['Resumo', 'Visão operacional da unidade', 'gauge'],
        vendas: ['Vendas', 'Registrar e consultar vendas', 'shopping-cart'],
        retiradas: ['Retiradas', 'Atender pedidos reservados pelo Bot', 'package-check'],
        clientes: ['Clientes', 'Consultar e acompanhar clientes', 'users'],
        pedidos: ['Pedidos', 'Consultar pedidos da unidade', 'clipboard-list'],
        compras: ['Compras', 'Registrar compras e recebimentos', 'shopping-cart'],
        estoque: ['Estoque', 'Consultar e movimentar estoque', 'package'],
        entregas: ['Logística', 'Rotas e entregas locais', 'truck'],
        financeiro: ['Financeiro', 'Caixa, cobranças e despesas', 'circle-dollar-sign'],
        batepapo: ['Bate-papo', 'Conversas e atendimento da unidade', 'messages-square'],
        colaboradores: ['Colaboradores', 'Consultar a equipe local', 'users-round'],
        catalogo: ['Catálogo', 'Produtos e preços da unidade', 'tag'],
      })[key] || [key, '', 'shield-check'];
    },
    partnerColaboradoresApplyPermissionModel() {
      const presets = {
        vendedor: ['resumo', 'vendas', 'retiradas', 'clientes', 'pedidos', 'batepapo', 'catalogo'],
        caixa: ['resumo', 'vendas', 'retiradas', 'clientes', 'pedidos', 'financeiro'],
        estoque: ['resumo', 'compras', 'estoque', 'pedidos', 'retiradas', 'catalogo'],
        entregador: ['resumo', 'entregas', 'pedidos'], gerente: keys,
      };
      const selected = presets[this.partnerColaboradores.permissionModel];
      if (!selected) return;
      const enabled = new Set(selected);
      this.partnerColaboradores.detail.permissions = Object.fromEntries(
        keys.map((key) => [key, enabled.has(key)]),
      );
    },
    async partnerColaboradoresOpenPermissions(row) {
      await this.partnerColaboradoresOpen(row);
      this.partnerColaboradores.permissionModel = 'custom';
    },
    async partnerColaboradoresSavePermissions() {
      const state = this.partnerColaboradores;
      if (!state.selected?.id || state.saving || state.detailLoading) return;
      state.saving = true; state.detailError = null;
      try {
        await this.partnerApiWrite(`equipe/${encodeURIComponent(state.selected.id)}/permissoes`, 'PUT',
          Object.fromEntries(keys.map((key) => [key, Boolean(state.detail.permissions[key])])));
        state.notice = `Permissões de ${state.selected.name || state.selected.username} atualizadas. A sessão anterior foi encerrada.`;
        await this.loadPartnerColaboradores();
      } catch (_) { state.detailError = 'Não foi possível salvar as permissões.'; }
      finally { state.saving = false; }
    },
    async partnerColaboradoresEndSessions() {
      const state = this.partnerColaboradores;
      if (!state.selected?.id || state.saving) return;
      state.saving = true;
      try {
        await this.partnerApiWrite(`funcionarios/${encodeURIComponent(state.selected.id)}/encerrar-sessoes`, 'POST', {});
        state.notice = `Sessões de ${state.selected.name || state.selected.username} encerradas.`;
      } catch (_) { state.detailError = 'Não foi possível encerrar as sessões.'; }
      finally { state.saving = false; }
    },
  };
};
