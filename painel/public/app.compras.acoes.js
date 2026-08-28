// Acoes mutaveis de atacado/compras. As chaves ficam vivas ate o servidor
// confirmar sucesso, portanto timeout e segundo clique repetem a mesma operacao.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasAcoes = function () {
  return {
    compraData(c) {
      if (!c?.purchased_at) return '—';
      return window.FarejadorTime.formatDate(c.purchased_at);
    },
    vendaData(v) {
      if (!v?.sold_at) return '—';
      return window.FarejadorTime.formatDate(v.sold_at);
    },
    financeDate(value) {
      if (!value) return 'sem data';
      const formatted = window.FarejadorTime.formatCivilDate(value);
      return formatted === '-' ? 'sem data' : formatted;
    },
    async compraOpenDetails(purchase) {
      this.compraDetalhe = purchase;
      this.compraOrderSelection = '';
      this.compraOrderOptions = [];
      this.compraDialog = {
        open: true, kind: 'details', purchase, supplier: null, reason: '', error: '',
      };
      if (!purchase.purchase_order_id) await this.compraLoadOrderOptions(purchase);
    },
    compraOpenAction(purchase, kind) {
      if (this.adminUser?.role !== 'owner') return;
      let reason = '';
      if (kind === 'cancel') {
        const operation = window.PAINEL_INTEGRITY.operation('wholesale-purchase-cancel', purchase.id);
        reason = operation.reason || '';
      }
      this.compraReceiptItems = kind === 'confirm'
        ? (purchase.items || []).map((item) => ({
          item_id: item.id,
          measure: item.measure,
          brand: item.brand,
          tire_condition: item.tire_condition,
          ordered_quantity: Number(item.ordered_quantity ?? item.quantity ?? 0),
          accepted_quantity: Number(item.ordered_quantity ?? item.quantity ?? 0),
          unit_cost: Number(item.unit_cost || 0),
        })) : [];
      this.compraDialog = {
        open: true, kind, purchase, supplier: null, reason, error: '',
      };
      this.$nextTick(() => {
        if (kind === 'cancel') this.$refs.compraDialogReason?.focus();
      });
    },
    compraCancel(purchase) {
      this.compraOpenAction(purchase, 'cancel');
    },
    fornecedorOpenCreate() {
      if (this.adminUser?.role !== 'owner') return;
      this.fornecedorForm = { name: '', phone: '', document: '', notes: '' };
      this.compraDialog = {
        open: true, kind: 'supplier-create', purchase: null, supplier: null, reason: '', error: '',
      };
      this.$nextTick(() => this.$refs.fornecedorDialogName?.focus());
    },
    fornecedorOpenArchive(supplier) {
      if (this.adminUser?.role !== 'owner') return;
      this.compraDialog = {
        open: true, kind: 'supplier-archive', purchase: null, supplier, reason: '', error: '',
      };
    },
    compraCloseDialog(force = false) {
      if (this.compraActionSaving && !force) return;
      this.compraDialog = {
        open: false, kind: null, purchase: null, supplier: null, reason: '', error: '',
      };
      this.compraDetalhe = null;
      this.compraReceiptItems = [];
      this.compraOrderOptions = [];
      this.compraOrderSelection = '';
    },
    compraDialogTitle() {
      const titles = {
        details: 'Detalhes da compra',
        confirm: 'Confirmar recebimento',
        cancel: 'Cancelar compra',
        'review-create': 'Revise antes de registrar',
        'supplier-create': 'Novo fornecedor',
        'supplier-archive': 'Arquivar fornecedor',
      };
      return titles[this.compraDialog.kind] || 'Compras';
    },
    compraDialogDescription() {
      const row = this.compraDialog.purchase;
      if (this.compraDialog.kind === 'confirm') {
        return `Confira o que realmente chegou de ${row?.supplier_name || 'fornecedor'}. Só a quantidade aceita entrará no galpão e no custo.`;
      }
      if (this.compraDialog.kind === 'cancel') {
        return row?.stock_applied
          ? 'A reversão só será aceita se saldo e custo ainda coincidirem com o filme original.'
          : 'A mercadoria ainda não entrou no galpão; o cancelamento não movimentará estoque.';
      }
      if (this.compraDialog.kind === 'supplier-archive') {
        return 'O fornecedor sairá das novas compras. Histórico e dívidas antigas continuam registrados.';
      }
      if (this.compraDialog.kind === 'review-create') {
        const warnings = this.compraDialog.warnings || {};
        const parts = [];
        if (warnings.discarded) parts.push(`${warnings.discarded} linha(s) incompleta(s) ficarão de fora`);
        if (warnings.zeroCost) parts.push('há item com custo R$ 0, que pode reduzir o custo médio');
        return parts.join('. ') + '. Confirme somente se os dados estiverem corretos.';
      }
      return '';
    },
    compraDialogConfirmLabel() {
      const labels = {
        confirm: 'Confirmar chegada', cancel: 'Cancelar compra',
        'review-create': 'Registrar mesmo assim',
        'supplier-create': 'Cadastrar fornecedor',
        'supplier-archive': 'Arquivar fornecedor',
      };
      return labels[this.compraDialog.kind] || 'Confirmar';
    },
    async confirmarCompraDialog() {
      if (this.adminUser?.role !== 'owner') return;
      const kind = this.compraDialog.kind;
      this.compraDialog.error = '';
      if (kind === 'review-create') {
        const body = this.compraPendingSubmission;
        this.compraCloseDialog(true);
        if (body) await this.compraPersist(body);
        return;
      }
      if (kind === 'confirm') return this.compraExecuteConfirm();
      if (kind === 'cancel') return this.compraExecuteCancel();
      if (kind === 'supplier-create') return this.fornecedorCreate();
      if (kind === 'supplier-archive') return this.fornecedorArchive();
    },
    async compraExecuteConfirm() {
      if (this.adminUser?.role !== 'owner') return;
      const purchase = this.compraDialog.purchase;
      const operation = window.PAINEL_INTEGRITY.operation('wholesale-purchase-confirm', purchase.id);
      const items = this.compraReceiptItems.map((item) => ({
        item_id: item.item_id,
        accepted_quantity: Number(item.accepted_quantity),
      }));
      if (!items.length || items.some((item) => !Number.isInteger(item.accepted_quantity)
        || item.accepted_quantity < 0)) {
        this.compraDialog.error = 'Confira as quantidades recebidas. Use somente números inteiros iguais ou maiores que zero.';
        return;
      }
      if (items.some((item, index) => item.accepted_quantity
        > Number(this.compraReceiptItems[index]?.ordered_quantity || 0))) {
        this.compraDialog.error = 'A quantidade recebida não pode ser maior que a quantidade comprada.';
        return;
      }
      if (!items.some((item) => item.accepted_quantity > 0)) {
        this.compraDialog.error = 'Informe pelo menos um pneu recebido. Para recusar tudo, cancele a compra.';
        return;
      }
      if (this.compraReceiptFinalTotal() < -0.001) {
        this.compraDialog.error = 'Com as recusas, o desconto ficou maior que produtos e frete. Cancele esta compra e registre os valores corretos.';
        return;
      }
      this.compraActionSaving = true;
      try {
        const result = await this.apiPost('/admin/api/wholesale/purchases/confirm', {
          purchase_id: purchase.id, items, idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('wholesale-purchase-confirm', purchase.id);
        this.compraCloseDialog(true);
        const catalogoTxt = result.catalog_blockers?.length
          ? ` ${result.catalog_blockers.length} variante(s) ainda precisam de produto ou preço no Catálogo antes da venda.` : '';
        this.compraMsg = { ok: true, text: `Recebimento confirmado. Galpão, custo médio e filme foram atualizados.${catalogoTxt}` };
        await Promise.allSettled([this.loadCompras(), this.loadFinanceiro(), this.loadSino()]);
      } catch (err) {
        this.compraDialog.error = `Não consegui confirmar o recebimento (${err.message}).`;
      } finally {
        this.compraActionSaving = false;
      }
    },
    compraReceiptTotal() {
      return this.compraReceiptItems.reduce((sum, item) => sum
        + Number(item.accepted_quantity || 0) * Number(item.unit_cost || 0), 0);
    },
    compraReceiptFinalTotal() {
      const purchase = this.compraDialog.purchase || {};
      return this.compraReceiptTotal() + Number(purchase.freight_amount || 0)
        - Number(purchase.discount_amount || 0);
    },
    async compraLoadOrderOptions(purchase) {
      if (!purchase?.supplier_id || purchase.purchase_order_id) return;
      this.compraOrderLoading = true;
      try {
        const qs = new URLSearchParams({ supplier_id: purchase.supplier_id, status: 'open' });
        this.compraOrderOptions = await this.apiGet('/admin/api/wholesale/purchase-orders?' + qs.toString());
      } catch (err) {
        this.compraDialog.error = `Não consegui carregar as ordens abertas (${err.message}).`;
      } finally {
        this.compraOrderLoading = false;
      }
    },
    async compraLinkOrder() {
      const purchase = this.compraDetalhe;
      if (!purchase?.id || !this.compraOrderSelection || this.compraActionSaving) return;
      const operation = window.PAINEL_INTEGRITY.operation('wholesale-purchase-link-order', purchase.id);
      this.compraActionSaving = true;
      this.compraDialog.error = '';
      try {
        const result = await this.apiPost('/admin/api/wholesale/purchases/link-order', {
          purchase_id: purchase.id,
          order_id: this.compraOrderSelection,
          idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('wholesale-purchase-link-order', purchase.id);
        purchase.purchase_order_id = result.order_id;
        purchase.order_code = result.order_code;
        this.compraOrderOptions = [];
        this.compraOrderSelection = '';
        this.compraMsg = { ok: true, text: `Compra vinculada à ${result.order_code}. Nenhum valor ou estoque foi alterado.` };
        await Promise.allSettled([this.loadComprasHistory(true), this.loadComprasOverview()]);
      } catch (err) {
        this.compraDialog.error = `Não consegui vincular a ordem (${err.message}).`;
      } finally {
        this.compraActionSaving = false;
      }
    },
    async compraExecuteCancel() {
      if (this.adminUser?.role !== 'owner') return;
      const purchase = this.compraDialog.purchase;
      const reason = this.compraDialog.reason.trim();
      if (reason.length < 2) {
        this.compraDialog.error = 'Informe um motivo com pelo menos 2 caracteres.';
        return;
      }
      const operation = window.PAINEL_INTEGRITY.operation('wholesale-purchase-cancel', purchase.id);
      operation.reason = reason;
      window.PAINEL_INTEGRITY.save();
      this.compraActionSaving = true;
      try {
        await this.apiPost('/admin/api/wholesale/purchases/cancel', {
          purchase_id: purchase.id, reason, idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('wholesale-purchase-cancel', purchase.id);
        this.compraCloseDialog(true);
        this.compraMsg = { ok: true, text: 'Compra cancelada com trilha preservada.' };
        await Promise.allSettled([this.loadCompras(), this.loadFinanceiro(), this.loadSino()]);
      } catch (err) {
        const consumed = String(err.message).startsWith('purchase_stock_consumed')
          || String(err.message).startsWith('purchase_stock_changed');
        this.compraDialog.error = consumed
          ? 'Não é seguro cancelar automaticamente: o estoque já foi consumido ou o custo mudou. Nada foi alterado.'
          : err.message === 'purchase_already_cancelled' ? 'Essa compra já estava cancelada.'
            : `Não consegui cancelar (${err.message}).`;
      } finally {
        this.compraActionSaving = false;
      }
    },
    async fornecedorCreate() {
      if (this.adminUser?.role !== 'owner') return;
      if (!this.fornecedorForm.name.trim()) {
        this.compraDialog.error = 'Informe o nome do fornecedor.';
        return;
      }
      this.compraActionSaving = true;
      try {
        const supplier = await this.apiPost('/admin/api/wholesale/suppliers', {
          name: this.fornecedorForm.name.trim(),
          phone: this.fornecedorForm.phone.trim() || null,
          document: this.fornecedorForm.document.trim() || null,
          notes: this.fornecedorForm.notes.trim() || null,
        });
        this.compraCloseDialog(true);
        await Promise.allSettled([this.loadComprasSuppliers(), this.loadCompras()]);
        this.comprasSupplierSelectedId = supplier.id;
        this.compraMsg = { ok: true, text: `Fornecedor ${supplier.name} cadastrado.` };
      } catch (err) {
        this.compraDialog.error = err.message === 'supplier_duplicate'
          ? 'Já existe um fornecedor com nome, documento ou telefone equivalente.'
          : `Não consegui cadastrar (${err.message}).`;
      } finally {
        this.compraActionSaving = false;
      }
    },
    async fornecedorArchive() {
      if (this.adminUser?.role !== 'owner') return;
      const supplier = this.compraDialog.supplier;
      this.compraActionSaving = true;
      try {
        await this.apiPost('/admin/api/wholesale/suppliers/archive', {
          supplier_id: supplier.supplier_id,
        });
        this.compraCloseDialog(true);
        this.comprasSupplierSelectedId = null;
        await Promise.allSettled([this.loadComprasSuppliers(), this.loadComprasOverview()]);
        this.compraMsg = { ok: true, text: `${supplier.name} foi arquivado. O histórico foi preservado.` };
      } catch (err) {
        this.compraDialog.error = `Não consegui arquivar (${err.message}).`;
      } finally {
        this.compraActionSaving = false;
      }
    },
    async atacadoCancelSale(v) {
      if (this.adminUser?.role !== 'owner') return;
      if (v.partner_transfer_status === 'in_transit') {
        await this.atacadoOpenArrival(v);
        return;
      }
      if (v.partner_transfer_status) {
        window.alert('Esta remessa já foi acertada com o parceiro e não pode usar o cancelamento comum. Faça uma devolução física registrada.');
        return;
      }
      const pago = v.payment_status === 'paid';
      const aviso = pago ? '\n\n⚠️ A venda consta como paga; o Financeiro criará uma devolução ao cliente em aberto.'
        : '\n\nEla sai do ranking, do resumo e do a receber.';
      if (!window.confirm(`Cancelar a venda de ${v.buyer_name} (${this.formatCurrency(Number(v.total_amount))})?${aviso}`)) return;
      const operation = window.PAINEL_INTEGRITY.operation('wholesale-sale-cancel', v.id);
      if (!Object.hasOwn(operation, 'reason')) {
        const reason = window.prompt('Motivo do cancelamento (obrigatório):');
        if (reason === null) { window.PAINEL_INTEGRITY.complete('wholesale-sale-cancel', v.id); return; }
        if (reason.trim().length < 2) {
          window.alert('Informe um motivo com pelo menos 2 caracteres.');
          window.PAINEL_INTEGRITY.complete('wholesale-sale-cancel', v.id);
          return;
        }
        operation.reason = reason.trim();
        window.PAINEL_INTEGRITY.save();
      }
      try {
        const result = await this.apiPost('/admin/api/wholesale/sales/cancel', {
          order_id: v.id, reason: operation.reason, idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('wholesale-sale-cancel', v.id);
        if (this.currentPage === 'vendas') await this.loadAtacadoVendas();
        else await this.loadAtacado();
        if (result.stock_unverified && result.stock_unverified.length) {
          const faltou = result.stock_unverified
            .map((item) => `${item.measure}: ${item.quantity}`).join('\n');
          window.alert(`Venda cancelada, mas só o estoque comprovado pelo histórico voltou.\n\nSem filme para:\n${faltou}\n\nConfira essas medidas no galpão.`);
        }
      } catch (err) {
        const msg = err.message === 'sale_already_cancelled' ? 'Essa venda já estava cancelada.'
          : err.message === 'sale_stock_history_missing'
            ? 'Cancelamento bloqueado: esta venda não tem histórico de baixa do estoque. Nada foi alterado. Confira o galpão antes de corrigir manualmente.'
          : `Não consegui cancelar (${err.message}).`;
        window.alert(msg);
      }
    },
    async financeSettle(kind, row) {
      if (this.adminUser?.role !== 'owner') return;
      const label = kind === 'sale' ? `receber de ${row.counterparty}` : `pagar para ${row.counterparty}`;
      if (!window.confirm(`Quitar ${this.formatCurrency(Number(row.total_amount))} (${label})?`)) return;
      const scope = `wholesale-${kind}-payment`;
      const operation = window.PAINEL_INTEGRITY.operation(scope, row.id);
      try {
        await this.apiPost('/admin/api/wholesale/finance/settle', {
          kind, id: row.id, idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete(scope, row.id);
        await this.loadAtacado();
      } catch (err) {
        window.alert(`Não consegui quitar (${err.message}). A mesma operação será reutilizada na tentativa seguinte.`);
      }
    },
  };
};
