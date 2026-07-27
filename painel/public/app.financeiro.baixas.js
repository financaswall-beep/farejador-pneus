// Baixas e extrato do livro financeiro central.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.financeiroBaixas = function () {
  return {
    finHoje() {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Sao_Paulo',
      }).format(new Date());
    },
    finMesAtual() {
      return this.finHoje().slice(0, 7);
    },
    finSettlementMode(item) {
      if (item.settlement_mode) return item.settlement_mode;
      const modes = {
        fiado: 'wholesale_sale', comissao: 'commission',
        mensalidade: 'monthly_fee', fornecedor: 'wholesale_purchase',
        despesa: 'expense', folha: 'expense',
        estorno_comissao: 'commission_refund',
      };
      return modes[item.tipo] || 'central_obligation';
    },
    finPermiteParcial(item) {
      return ['retail_sale', 'central_obligation', 'central_account']
        .includes(this.finSettlementMode(item));
    },
    finAbrirBaixa(item, direction) {
      if (this.finQuitando || this.adminUser?.role !== 'owner') return;
      this.finBaixaModal = {
        open: true, item, direction,
        amount: Number(item.valor || 0).toFixed(2).replace('.', ','),
        payment_date: this.finHoje(), payment_method: 'pix',
        cash_account: 'Caixa principal', note: '', error: null,
      };
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    finFecharBaixa(force = false) {
      if (this.finQuitando && !force) return;
      this.finBaixaModal.open = false;
      this.finBaixaModal.item = null;
      this.finBaixaModal.error = null;
    },
    async finConfirmarBaixa() {
      const modal = this.finBaixaModal;
      const item = modal.item;
      if (!item || this.finQuitando) return;
      const amount = Number(String(modal.amount).trim().replace(/\./g, '').replace(',', '.'));
      const balance = Number(item.valor || 0);
      if (!Number.isFinite(amount) || amount <= 0 || amount > balance + 0.001) {
        modal.error = 'O valor precisa ser maior que zero e não pode ultrapassar o saldo.';
        return;
      }
      if (!this.finPermiteParcial(item) && Math.abs(amount - balance) > 0.001) {
        modal.error = 'Este lançamento só aceita baixa integral. Use o saldo completo.';
        return;
      }
      if (!modal.payment_date || !String(modal.payment_method).trim()) {
        modal.error = 'Informe a data e a forma do pagamento.';
        return;
      }
      const mode = this.finSettlementMode(item);
      const targetKey = `${mode}:${item.id}:${amount}:${modal.payment_date}`;
      const operation = window.PAINEL_INTEGRITY.operation(
        'finance-settlement-facade', targetKey,
      );
      const target = mode === 'central_account'
        ? { account_code: item.account_code || undefined }
        : ['retail_sale', 'central_obligation'].includes(mode)
          ? { obligation_id: item.obligation_id || undefined }
          : {};
      this.finQuitando = true;
      modal.error = null;
      try {
        await this.apiPost('/admin/api/matriz/financeiro/settle', {
          settlement_mode: mode,
          target_id: item.id,
          ...target,
          amount: this.finPermiteParcial(item) ? amount : undefined,
          paid_at: new Date(`${modal.payment_date}T12:00:00-03:00`).toISOString(),
          payment_method: String(modal.payment_method).trim(),
          cash_account: String(modal.cash_account || '').trim() || undefined,
          note: String(modal.note || '').trim() || undefined,
          idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('finance-settlement-facade', targetKey);
        this.finFecharBaixa(true);
        await Promise.allSettled([
          this.loadFinanceiro(), this.loadSino(), this.loadFinExtrato(),
        ]);
      } catch (err) {
        modal.error = `Não consegui concluir a baixa (${err.message}).`;
      } finally {
        this.finQuitando = false;
      }
    },
    async finOpenTab(tab) {
      this.finTab = tab;
      if (tab === 'extrato') await this.loadFinExtrato();
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    async loadFinExtrato() {
      if (this.finExtratoLoading || !this.adminAuthenticated) return;
      if (!this.finExtratoFiltro.mes) this.finExtratoFiltro.mes = this.finMesAtual();
      this.finExtratoLoading = true;
      try {
        const qs = new URLSearchParams({
          mes: this.finExtratoFiltro.mes,
          base: this.finExtratoFiltro.base,
          limit: '200',
        });
        this.finExtrato = await this.apiGet(
          '/admin/api/matriz/financeiro/ledger/statement?' + qs.toString(),
        );
      } catch (err) {
        console.warn('extrato financeiro central falhou:', err.message);
        this.finExtrato = null;
      } finally {
        this.finExtratoLoading = false;
      }
    },
    finExtratoStatus(row) {
      const labels = {
        aberto: 'Em aberto', parcial: 'Parcial', liquidado: 'Liquidado',
        estornado: 'Estornado', estorno: 'Estorno', registrado: 'Registrado',
      };
      const classes = {
        aberto: 'bg-amber-50 text-amber-700', parcial: 'bg-sky-50 text-sky-700',
        liquidado: 'bg-emerald-50 text-emerald-700',
        estornado: 'bg-gray-100 text-gray-500', estorno: 'bg-rose-50 text-rose-700',
        registrado: 'bg-gray-100 text-gray-600',
      };
      return {
        label: labels[row.status] || row.status,
        cls: classes[row.status] || classes.registrado,
      };
    },
  };
};
