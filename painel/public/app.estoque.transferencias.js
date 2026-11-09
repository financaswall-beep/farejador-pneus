window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.estoqueTransferencias = function () {
  const base = '/admin/api/wholesale/stock-transfers';
  return {
    st: { open: false, kind: 'to_stock', lot: null, items: [], quantity: 1, stock_id: '', description: '',
      reason: '', products: [], search: '', preview: null, pending: null, busy: false, error: '', message: '',
      history: [], historyOpen: false, total: 0, page: 1, lot_id: '', filter_stock_id: '', request: 0, productRequest: 0, recoveryBlocked: false },
    stKey() { return 'farejador:tire-transfer:' + this.serverEnvironment + ':' + (this.adminUser?.id || this.adminUser?.username || 'owner'); },
    stLabel(kind) { return ({ to_stock: 'Desmembrar lote', to_lot: 'Formar lote', loss: 'Registrar perda na triagem', reversal: 'Estornar movimentação' })[kind] || kind; },
    stConditionLabel(value) { return ({ meia_vida: 'Meia-vida', novo: 'Novo', remold: 'Remold' })[value] || value; },
    stProductLabel(p) { return [p.measure, p.brand || 'Sem marca', this.stConditionLabel(p.tire_condition), p.vehicle_type === 'car' ? 'Carro' : 'Moto'].join(' · '); },
    stError(error) {
      const code = error?.payload?.error || error?.data?.error || error?.message || '';
      const messages = {
        transfer_preview_changed: 'O estoque ou custo mudou. Confira uma nova prévia antes de confirmar.',
        transfer_lot_insufficient: 'A quantidade ultrapassa o saldo disponível do lote, descontadas as reservas.',
        transfer_stock_insufficient: 'A quantidade ultrapassa o estoque disponível, descontadas as reservas.',
        transfer_product_invalid: 'Escolha um produto ativo com medida, condição e tipo de veículo definidos no catálogo.',
        transfer_duplicate_variant: 'Agrupe a quantidade da mesma medida, marca e condição em uma única linha.',
        transfer_vehicle_mismatch: 'O produto não corresponde ao tipo de veículo do lote.',
        transfer_has_later_movements: 'Houve movimentação posterior ou há reservas. O estorno simples foi bloqueado.',
        transfer_already_reversed: 'Esta movimentação já foi estornada. Atualize o histórico.',
        transfer_lot_unavailable: 'O lote não foi recebido, foi cancelado ou não está disponível.',
        transfer_loss_finance_required: 'O livro financeiro precisa estar ativo para registrar uma perda.',
        transfer_cost_precision: 'O volume impede preservar os centavos com a precisão do estoque. Solicite revisão.',
        transfer_stock_review_required: 'A variante de destino tem saldo ou custo que precisa de revisão antes da entrada.',
        transfer_cost_missing: 'O estoque de origem precisa ter um custo válido.',
        transfer_cost_limit: 'O custo ultrapassa o limite de um lote. Separe uma quantidade menor.',
        transfer_migration_required: 'A atualização do banco de estoque ainda não foi aplicada. As transferências estão bloqueadas.',
        transfer_not_found: 'A movimentação original não está disponível para estorno.',
        transfer_loss_history_missing: 'O histórico financeiro desta perda precisa de revisão. Nada foi alterado.',
        invalid_body: 'Confira os produtos, as quantidades e o motivo (mínimo de 5 caracteres).',
      };
      const found = Object.keys(messages).find(k => String(code).includes(k));
      return { definitive: !!found, text: found ? messages[found] : 'Não foi possível confirmar. Tente novamente com a mesma tentativa.' };
    },
    async stOpen(kind, lot) {
      if (this.st.busy || this.adminUser?.role !== 'owner') return;
      this._stFocusReturn = document.activeElement;
      const s = this.st; Object.assign(s, { open: true, kind, lot: lot || null, items: [{ product_id: '', quantity: 1 }],
        quantity: 1, stock_id: '', description: '', reason: '', preview: null, pending: null, error: '', message: '', search: '', recoveryBlocked: false });
      try {
        const saved = JSON.parse(sessionStorage.getItem(this.stKey()) || 'null');
        if (!saved && kind === 'to_lot' && this.tireLotSeparationKey && sessionStorage.getItem(this.tireLotSeparationKey())) {
          s.open = false; await this.tireLotSeparationOpen(); return;
        }
        if (saved) {
          s.pending = saved; s.kind = saved.reverse ? 'reversal' : saved.input.kind; s.reason = saved.reason || saved.input?.reason;
          s.lot = { id: saved.id || saved.input?.lot_id, lot_code: saved.id || saved.input?.lot_id || 'Nova formação de lote', description: 'Tentativa anterior salva' };
          s.items = saved.input?.items || []; s.quantity = saved.input?.quantity || 1;
          s.stock_id = saved.input?.stock_id || ''; s.description = saved.input?.description || '';
        }
      } catch (_) { s.recoveryBlocked = true; s.error = 'Não foi possível recuperar a tentativa anterior. Confira o histórico e solicite revisão da sessão antes de lançar novamente.'; }
      if (kind === 'to_lot') await this.tireLotSourcesLoad();
      if (kind === 'to_stock') await this.stProducts();
      this.$nextTick(() => document.getElementById('stock-transfer-title')?.focus());
    },
    stClose() { if (!this.st.busy) { this.st.open = false; this.$nextTick(() => this._stFocusReturn?.focus()); } },
    stTrap(event) {
      const nodes = [...event.currentTarget.querySelectorAll('button,input,select,textarea,[tabindex="0"]')]
        .filter(n => !n.disabled && n.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    },
    async stProducts() {
      const s = this.st, request = ++s.productRequest;
      try { const data = await this.apiGet('/admin/api/wholesale/stock-transfer-products?search=' + encodeURIComponent(s.search));
        if (request === s.productRequest) {
          const selected = new Set(s.items.map(i => i.product_id));
          s.products = [...new Map([...s.products.filter(p => selected.has(p.id)), ...data.rows].map(p => [p.id, p])).values()];
        } }
      catch (_) { if (request === s.productRequest) s.error = 'Não foi possível consultar o catálogo.'; }
    },
    stBody() {
      const s = this.st;
      if (s.kind === 'to_lot') return { kind: s.kind, stock_id: s.stock_id, quantity: Number(s.quantity), description: s.description.trim(), reason: s.reason.trim() };
      return { kind: s.kind, lot_id: s.lot.id, reason: s.reason.trim(),
        ...(s.kind === 'loss' ? { quantity: Number(s.quantity) } : { items: s.items.map(i => ({ product_id: i.product_id, quantity: Number(i.quantity) })) }) };
    },
    async stPreview() {
      const s = this.st; if (s.busy || s.pending || s.recoveryBlocked) return;
      s.busy = true; s.error = ''; s.preview = null;
      try { s.preview = await this.apiPost(base + '/preview', this.stBody()); }
      catch (error) { s.error = this.stError(error).text; }
      finally { s.busy = false; }
    },
    async stConfirm() {
      const s = this.st; if (s.busy || s.recoveryBlocked || this.adminUser?.role !== 'owner') return;
      if (!s.pending) {
        if (s.kind !== 'reversal' && !s.preview) return;
        s.pending = s.kind === 'reversal'
          ? { reverse: true, id: s.lot.id, reason: s.reason.trim(), idempotency_key: crypto.randomUUID() }
          : { input: s.preview.input, fingerprint: s.preview.fingerprint, idempotency_key: crypto.randomUUID() };
        try { sessionStorage.setItem(this.stKey(), JSON.stringify(s.pending)); }
        catch (_) { s.pending = null; s.error = 'Habilite o armazenamento da sessão para confirmar sem duplicar.'; return; }
      }
      s.busy = true; s.error = '';
      try {
        const pending = s.pending;
        const { reverse, ...body } = pending;
        const result = await this.apiPost(base + (reverse ? '/reverse' : ''), body);
        if (!result.id) throw Error('confirmation_missing');
        sessionStorage.removeItem(this.stKey()); s.pending = null; s.open = false;
        s.message = 'Movimentação registrada. Quantidades, custos e histórico foram atualizados.';
        this.$nextTick(() => this._stFocusReturn?.focus());
        await Promise.allSettled([this.tireLotsLoad(), this.tireLotsLoadMovements(), this.loadAtacado(),
          this.loadStockCostsPage?.(), this.stHistoryLoad(), this.loadFinanceiro?.()]);
      } catch (error) {
        const detail = this.stError(error); s.error = detail.text;
        if (detail.definitive) {
          sessionStorage.removeItem(this.stKey()); s.pending = null; s.preview = null;
          await this.stHistoryLoad();
        }
      } finally { s.busy = false; }
    },
    async stHistory(lotId = '', stockId = '') {
      Object.assign(this.st, { historyOpen: true, page: 1, lot_id: lotId, filter_stock_id: stockId, error: '' });
      await this.stHistoryLoad();
      this.$nextTick(() => document.getElementById('stock-transfer-history')?.scrollIntoView({ block: 'start' }));
    },
    async stHistoryLoad() {
      const s = this.st; if (!s.historyOpen) return;
      const request = ++s.request;
      const qs = new URLSearchParams({ page: s.page }); if (s.lot_id) qs.set('lot_id', s.lot_id); if (s.filter_stock_id) qs.set('stock_id', s.filter_stock_id);
      try { const data = await this.apiGet(base + '?' + qs); if (request === s.request) { s.history = data.rows; s.total = data.total; } }
      catch (_) { if (request === s.request) s.error = 'Não foi possível consultar o histórico das transferências.'; }
    },
  };
};
