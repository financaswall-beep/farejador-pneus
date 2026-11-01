window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasViagens = function () {
  const base = '/admin/api/wholesale/purchase-groups';
  return {
    viagens: [], viagensAbertas: [], viagensTodas: [], viagensLoaded: false, viagensLoading: false,
    viagensError: '', viagemDetalhe: null, viagemSaving: false, viagemDespesaAlvo: '',
    viagemDespesaBusca: [], viagemBuscaPagina: 1, viagemBuscaOpen: false, viagemBuscaLoading: false,
    viagemCompraEtiquetaId: '', viagemCompraEtiquetaData: null, viagemCompraEtiquetaLoading: false,
    viagemCompraSelecionada: '', viagensPage: 1, viagensHasMore: false,
    viagensEnsure() {
      if (!this.viagensLoaded && !this.viagensLoading) void this.viagensLoad();
    },
    async viagensLoad() {
      this.viagensLoaded = true; this.viagensLoading = true; this.viagensError = '';
      try {
        const data = await this.apiGet(base + '?page=' + this.viagensPage);
        this.viagens = data.rows || []; this.viagensHasMore = !!data.has_more;
        const options = []; let page = 1, more = true;
        while (more) {
          const open = await this.apiGet(base + '?limit=100&page=' + page++);
          options.push(...(open.rows || [])); more = !!open.has_more;
        }
        this.viagensTodas = options; this.viagensAbertas = options.filter(g => g.status === 'open');
      } catch (error) { this.viagensError = this.viagemErro(error); }
      finally { this.viagensLoading = false; }
    },
    async viagemAbrir(id) {
      this.currentPage = 'compras'; this.comprasTab = 'viagem'; this.viagemDetalhe = null;
      this.viagensError = ''; this.viagensLoading = true; this.viagemBuscaOpen = false;
      try {
        this.viagemDetalhe = await this.apiGet(base + '/' + id);
        this.$nextTick(() => document.getElementById('farejador-main')?.scrollTo({ top: 0 }));
      }
      catch (error) { this.viagensError = this.viagemErro(error); }
      finally { this.viagensLoading = false; }
    },
    async viagemAtualizar() {
      const id = this.viagemDetalhe?.group?.id;
      await this.viagensLoad();
      if (id) await this.viagemAbrir(id);
    },
    viagemVoltar() { this.comprasTab = 'visao'; void this.viagensLoad(); },
    viagemErro(error) {
      const labels = {
        purchase_group_closed: 'Esta viagem está fechada. Reabra para alterar os vínculos.',
        purchase_group_not_empty: 'Desvincule as compras e os gastos antes de excluir a viagem.',
        purchase_already_grouped: 'Esta compra já pertence a uma viagem.',
        expense_already_grouped: 'Esta despesa já pertence a uma viagem.',
        purchase_order_split_across_groups: 'As compras da mesma OC precisam ficar na mesma viagem.',
        expense_owned_by_other_module: 'Esse gasto pertence a uma rota, folha ou comissão e não pode entrar na viagem.',
        purchase_cancelled: 'Uma compra cancelada não pode ser vinculada.',
        expense_not_found: 'Despesa removida ou indisponível.',
        idempotency_conflict: 'A tentativa anterior tem outros dados. Confira o resultado antes de reenviar.',
      };
      return labels[error.message] || ('Não foi possível concluir: ' + error.message);
    },
    async viagemAcao(action) {
      const group = this.viagemDetalhe?.group;
      if (!group || this.viagemSaving) return;
      if (action === 'delete' && !window.confirm('Excluir esta viagem vazia?')) return;
      const operation = window.PAINEL_INTEGRITY.operation('purchase-group-' + action, group.id);
      this.viagemSaving = true; this.viagensError = '';
      try {
        await this.apiPost(base + '/' + group.id + '/action', { action, idempotency_key: operation.key });
        window.PAINEL_INTEGRITY.complete('purchase-group-' + action, group.id);
        if (action === 'delete') this.viagemVoltar(); else await this.viagemAtualizar();
      } catch (error) { this.viagensError = this.viagemErro(error); }
      finally { this.viagemSaving = false; }
    },
    async viagemVinculo(groupId, kind, recordId, unlink) {
      if (!groupId || !recordId || this.viagemSaving) return;
      const subject = kind + ':' + recordId + ':' + groupId;
      const action = unlink ? 'purchase-group-unlink' : 'purchase-group-link';
      const operation = window.PAINEL_INTEGRITY.operation(action, subject);
      this.viagemSaving = true; this.viagensError = '';
      try {
        await this.apiPost(base + '/' + groupId + '/link', {
          kind, record_id: recordId, unlink: !!unlink, idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete(action, subject);
        if (kind === 'purchase') {
          this.viagemCompraEtiquetaId = ''; await this.viagemCompraEtiqueta({ id: recordId });
        }
        this.viagemCompraSelecionada = '';
        await this.viagensLoad();
        if (this.comprasTab === 'viagem') await this.viagemAbrir(groupId);
        if (this.currentPage === 'financeiro') await this.loadDespesas();
      } catch (error) { this.viagensError = this.viagemErro(error); }
      finally { this.viagemSaving = false; }
    },
    async viagemCompraEtiqueta(purchase) {
      if (!purchase?.id || this.viagemCompraEtiquetaId === purchase.id) return;
      this.viagemCompraEtiquetaId = purchase.id; this.viagemCompraEtiquetaData = null;
      this.viagemCompraSelecionada = ''; this.viagemCompraEtiquetaLoading = true;
      try {
        const data = await this.apiGet(base + '/by-purchase/' + purchase.id);
        if (this.viagemCompraEtiquetaId === purchase.id) this.viagemCompraEtiquetaData = data.group;
        if (!this.viagensLoaded) await this.viagensLoad();
      } catch (error) { this.viagensError = this.viagemErro(error); }
      finally { this.viagemCompraEtiquetaLoading = false; }
    },
    viagemLancarGasto() {
      if (this.viagemDetalhe?.group?.status !== 'open') return;
      if (!this.hasPanelModule('financeiro')) { this.viagensError = 'Seu acesso não permite abrir Despesas.'; return; }
      this.despesaForm.group_id = this.viagemDetalhe.group.id;
      this.currentPage = 'financeiro'; this.finTab = 'despesas'; void this.loadFinanceiro();
      this.$nextTick(() => document.getElementById('viagem-despesa-form')?.scrollIntoView({ block: 'start' }));
    },
    viagemVerDespesa(expense) {
      if (!this.hasPanelModule('financeiro')) { this.viagensError = 'Seu acesso não permite abrir Despesas.'; return; }
      this.viagemDespesaAlvo = expense.id; this.despesaFiltro.group_id = this.viagemDetalhe.group.id;
      this.despesaFiltro.mes = String(expense.competence_month || expense.occurred_at || '').slice(0, 7);
      this.despesaFiltro.categoria = ''; this.currentPage = 'financeiro'; this.finTab = 'despesas';
      void this.loadFinanceiro();
    },
    async viagemPuxarDespesas(page) {
      this.viagemBuscaPagina = page || 1; this.viagemBuscaOpen = true; this.viagemBuscaLoading = true;
      try {
        const data = await this.apiGet(base + '/eligible-expenses?page=' + this.viagemBuscaPagina);
        this.viagemDespesaBusca = data.rows || [];
      } catch (error) { this.viagensError = this.viagemErro(error); }
      finally { this.viagemBuscaLoading = false; }
    },
  };
};
