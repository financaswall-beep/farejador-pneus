// Conferência física das compras no painel moderno. Usa o mesmo endpoint da
// Operação da Loja; não replica regras de estoque nem permite ajustar a Matriz.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerComprasReceipt = function () {
  const emptyReceipt = () => ({
    open: false, rowId: '', saving: false, error: '', confirmed: false,
    idempotency_key: null, quantities: {},
  });
  const quantity = (item) => Number(item.confirmed_quantity ?? item.quantity ?? 0);
  return {
    partnerComprasReceipt: emptyReceipt(),

    partnerComprasSelected() {
      const rows = this.partnerComprasFiltered();
      return rows.find((row) => row.id === this.partnerCompras.selectedId) || rows[0] || null;
    },

    partnerComprasSelect(row) {
      this.partnerCompras.selectedId = row?.id || '';
      this.partnerComprasReceipt = emptyReceipt();
      this.$nextTick(() => lucide.createIcons());
    },

    partnerComprasUnits(row) {
      return (row?.items || []).reduce((sum, item) => sum + quantity(item), 0);
    },

    partnerComprasSummary() {
      const rows = this.partnerCompras.rows;
      const pendingRows = rows.filter((row) => row.receipt_status === 'pending');
      const payableRows = rows.filter((row) => row.payment_status === 'payable');
      const units = rows.reduce((sum, row) => sum + this.partnerComprasUnits(row), 0);
      const total = rows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
      return {
        purchases: rows.length,
        units,
        pending: pendingRows.length,
        pendingUnits: pendingRows.reduce((sum, row) => sum + this.partnerComprasUnits(row), 0),
        payables: payableRows.length,
        payablesTotal: payableRows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0),
        total,
        averageUnitCost: units > 0 ? total / units : 0,
      };
    },

    partnerComprasStatusClass(row) {
      if (row?.receipt_status === 'received') return 'bg-emerald-100 text-emerald-800';
      if (row?.source_wholesale_order_id && !row?.matrix_arrival_settled) {
        return 'bg-amber-100 text-amber-800';
      }
      return 'bg-sky-100 text-sky-800';
    },

    partnerComprasSource(row) {
      return row?.source_wholesale_order_id ? 'Enviado pela Matriz' : 'Fornecedor local';
    },

    partnerComprasCanReceive(row) {
      return row?.receipt_status === 'pending'
        && (!row.source_wholesale_order_id || row.matrix_arrival_settled === true);
    },

    partnerComprasArrivalLabel(row) {
      if (row?.receipt_status === 'received') return 'Estoque atualizado';
      if (row?.source_wholesale_order_id && !row?.matrix_arrival_settled) {
        return 'A Matriz está conferindo a remessa';
      }
      return 'Aguardando conferência física';
    },

    partnerComprasItemLabel(item) {
      return [item?.tire_size, item?.brand, item?.item_name].filter(Boolean).join(' · ')
        || 'Item da compra';
    },

    partnerComprasOpenReceipt(row) {
      if (!this.partnerComprasCanReceive(row)) return;
      const quantities = {};
      for (const item of row.items || []) quantities[item.item_id] = quantity(item);
      this.partnerComprasReceipt = {
        open: true, rowId: row.id, saving: false, error: '', confirmed: false,
        idempotency_key: null, quantities,
      };
    },

    partnerComprasReceiptRow() {
      return this.partnerCompras.rows.find((row) => row.id === this.partnerComprasReceipt.rowId) || null;
    },

    partnerComprasReceiptExpected(item) {
      return quantity(item);
    },

    partnerComprasReceiptValidation() {
      const state = this.partnerComprasReceipt;
      const row = this.partnerComprasReceiptRow();
      if (!row || !this.partnerComprasCanReceive(row)) return 'Esta compra ainda não pode ser recebida.';
      if (!state.confirmed) return 'Confirme que os produtos e as quantidades foram conferidos.';
      for (const item of row.items || []) {
        const received = Number(state.quantities[item.item_id]);
        if (!Number.isInteger(received) || received < 0 || received > 999999) {
          return 'Revise as quantidades recebidas.';
        }
        if (row.source_wholesale_order_id && received !== quantity(item)) {
          return 'A quantidade enviada pela Matriz não pode ser alterada nesta tela.';
        }
      }
      return '';
    },

    partnerComprasReceiptError(error) {
      const code = String(error?.code || error?.message || '');
      if (code === 'matrix_shipment_arrival_not_settled') return 'A Matriz ainda não concluiu a remessa.';
      if (code === 'matrix_shipment_requires_arrival_adjustment') {
        return 'A divergência deve ser corrigida primeiro pela Matriz.';
      }
      if (code === 'purchase_already_received') return 'Esta compra já foi recebida.';
      if (code === 'purchase_items_mismatch') return 'Os itens mudaram. Atualize a tela e confira novamente.';
      return 'Não foi possível confirmar o recebimento. O estoque não foi alterado.';
    },

    async partnerComprasConfirmReceipt() {
      const state = this.partnerComprasReceipt;
      state.error = this.partnerComprasReceiptValidation();
      if (state.error || state.saving) return;
      const row = this.partnerComprasReceiptRow();
      state.saving = true;
      state.idempotency_key = state.idempotency_key || `panel-receipt-${crypto.randomUUID()}`;
      try {
        await this.partnerApiWrite(
          `operacao/compras/${encodeURIComponent(row.id)}/receber`, 'POST', {
            idempotency_key: state.idempotency_key,
            items: row.items.map((item) => ({
              item_id: item.item_id,
              received_quantity: Number(state.quantities[item.item_id]),
            })),
          },
        );
        this.partnerCompras.notice = 'Recebimento confirmado. O estoque da unidade foi atualizado.';
        this.partnerComprasReceipt = emptyReceipt();
        await this.loadPartnerCompras();
      } catch (error) {
        state.error = this.partnerComprasReceiptError(error);
      } finally {
        state.saving = false;
      }
    },

    partnerComprasCloseReceipt() {
      if (!this.partnerComprasReceipt.saving) this.partnerComprasReceipt = emptyReceipt();
    },
  };
};
