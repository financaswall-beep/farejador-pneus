// Acoes mutaveis de atacado/compras. As chaves ficam vivas ate o servidor
// confirmar sucesso, portanto timeout e segundo clique repetem a mesma operacao.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasAcoes = function () {
  return {
    compraData(c) {
      if (!c.purchased_at) return '—';
      const date = new Date(c.purchased_at);
      return isNaN(date.getTime()) ? '—' : date.toLocaleDateString('pt-BR');
    },
    vendaData(v) {
      if (!v.sold_at) return '—';
      const date = new Date(v.sold_at);
      return isNaN(date.getTime()) ? '—' : date.toLocaleDateString('pt-BR');
    },
    financeDate(value) {
      if (!value) return 'sem data';
      const date = new Date(value + (String(value).length === 10 ? 'T12:00:00' : ''));
      return isNaN(date.getTime()) ? 'sem data' : date.toLocaleDateString('pt-BR');
    },
    async compraCancel(c, action) {
      if (action === 'confirm') {
        if (!window.confirm(`Confirmar que os pneus de ${c.supplier_name} chegaram ao galpão?`)) return;
        const receipt = window.PAINEL_INTEGRITY.operation('wholesale-purchase-confirm', c.id);
        try {
          await this.apiPost('/admin/api/wholesale/purchases/confirm', {
            purchase_id: c.id, idempotency_key: receipt.key,
          });
          window.PAINEL_INTEGRITY.complete('wholesale-purchase-confirm', c.id);
          await this.loadAtacado();
        } catch (err) {
          window.alert(`Não consegui confirmar o recebimento (${err.message}).`);
        }
        return;
      }
      const pago = c.payment_status === 'paid';
      const estoque = c.status === 'pending'
        ? '\n\nA compra está pendente e ainda não mexeu no galpão.'
        : '\n\nO cancelamento só passa se quantidade e valor puderem ser revertidos por inteiro.';
      const dinheiro = pago ? '\n⚠️ Ela consta como paga; o acerto financeiro com o fornecedor é externo.' : '';
      if (!window.confirm(`Cancelar a compra de ${c.supplier_name} (${this.formatCurrency(Number(c.total_amount))})?${estoque}${dinheiro}`)) return;
      const operation = window.PAINEL_INTEGRITY.operation('wholesale-purchase-cancel', c.id);
      if (!Object.hasOwn(operation, 'reason')) {
        const reason = window.prompt('Motivo do cancelamento (obrigatório):');
        if (reason === null) { window.PAINEL_INTEGRITY.complete('wholesale-purchase-cancel', c.id); return; }
        if (reason.trim().length < 2) {
          window.alert('Informe um motivo com pelo menos 2 caracteres.');
          window.PAINEL_INTEGRITY.complete('wholesale-purchase-cancel', c.id);
          return;
        }
        operation.reason = reason.trim();
        window.PAINEL_INTEGRITY.save();
      }
      try {
        await this.apiPost('/admin/api/wholesale/purchases/cancel', {
          purchase_id: c.id, reason: operation.reason, idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('wholesale-purchase-cancel', c.id);
        await this.loadAtacado();
      } catch (err) {
        const consumed = String(err.message).startsWith('purchase_stock_consumed');
        const msg = consumed
          ? 'Não dá para cancelar automaticamente: parte desse estoque já foi consumida ou o valor mudou. Nada foi alterado.'
          : err.message === 'purchase_already_cancelled' ? 'Essa compra já estava cancelada.'
            : `Não consegui cancelar (${err.message}).`;
        window.alert(msg);
      }
    },
    async fornecedorArchive(s) {
      if (!window.confirm(`Arquivar o fornecedor ${s.name}?\n\nCompras e dívidas antigas continuam registradas.`)) return;
      try {
        await this.apiPost('/admin/api/wholesale/suppliers/archive', { supplier_id: s.supplier_id });
        await this.loadAtacado();
      } catch (err) {
        window.alert(`Não consegui arquivar (${err.message}).`);
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
