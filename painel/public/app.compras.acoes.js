// Acoes mutaveis de atacado/compras. As chaves ficam vivas ate o servidor
// confirmar sucesso, portanto timeout e segundo clique repetem a mesma operacao.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasAcoes = function () {
  return {
    compraData(c) {
      if (!c?.purchased_at) return '—';
      const date = new Date(c.purchased_at);
      return isNaN(date.getTime()) ? '—' : date.toLocaleDateString('pt-BR');
    },
    vendaData(v) {
      if (!v?.sold_at) return '—';
      const date = new Date(v.sold_at);
      return isNaN(date.getTime()) ? '—' : date.toLocaleDateString('pt-BR');
    },
    financeDate(value) {
      if (!value) return 'sem data';
      const date = new Date(value + (String(value).length === 10 ? 'T12:00:00' : ''));
      return isNaN(date.getTime()) ? 'sem data' : date.toLocaleDateString('pt-BR');
    },
    compraOpenDetails(purchase) {
      this.compraDetalhe = purchase;
      this.compraDialog = {
        open: true, kind: 'details', purchase, supplier: null, reason: '', error: '',
      };
    },
    compraOpenAction(purchase, kind) {
      let reason = '';
      if (kind === 'cancel') {
        const operation = window.PAINEL_INTEGRITY.operation('wholesale-purchase-cancel', purchase.id);
        reason = operation.reason || '';
      }
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
      this.fornecedorForm = { name: '', phone: '', document: '', notes: '' };
      this.compraDialog = {
        open: true, kind: 'supplier-create', purchase: null, supplier: null, reason: '', error: '',
      };
      this.$nextTick(() => this.$refs.fornecedorDialogName?.focus());
    },
    fornecedorOpenArchive(supplier) {
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
        return `Os pneus de ${row?.supplier_name || 'fornecedor'} entrarão no galpão e o custo médio será recalculado uma única vez.`;
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
      const purchase = this.compraDialog.purchase;
      const operation = window.PAINEL_INTEGRITY.operation('wholesale-purchase-confirm', purchase.id);
      this.compraActionSaving = true;
      try {
        await this.apiPost('/admin/api/wholesale/purchases/confirm', {
          purchase_id: purchase.id, idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('wholesale-purchase-confirm', purchase.id);
        this.compraCloseDialog(true);
        this.compraMsg = { ok: true, text: 'Recebimento confirmado. Galpão, custo médio e filme foram atualizados.' };
        await Promise.allSettled([this.loadCompras(), this.loadFinanceiro(), this.loadSino()]);
      } catch (err) {
        this.compraDialog.error = `Não consegui confirmar o recebimento (${err.message}).`;
      } finally {
        this.compraActionSaving = false;
      }
    },
    async compraExecuteCancel() {
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
      const pago = v.payment_status === 'paid';
      const aviso = pago ? '\n\n⚠️ A venda consta como paga; o acerto financeiro é externo.'
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
