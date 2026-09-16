window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.financeiroRetiradas = function () {
  let opener = null;
  return {
    finRetirada: { open: false, saving: false, error: '', row: null }, finRetiradaAviso: '',
    finRetiradaAbrir(row = null) {
      if (this.adminUser?.role !== 'owner') return;
      opener = document.activeElement;
      this.finRetirada = {
        open: true, saving: false, error: '', row, amount: '', reason: '',
        date: this.finHoje(), payment_method: 'dinheiro', cash_account: 'Caixa principal',
      };
      this.$nextTick(() => { (row ? this.$refs.finRetiradaReason : this.$refs.finRetiradaFirst)?.focus(); window.lucide?.createIcons(); });
    },
    finRetiradaFechar() { if (!this.finRetirada.saving) { this.finRetirada.open = false; opener?.focus(); } },
    finRetiradaTeclado(event) {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll('button,input,select,textarea')].filter(el => !el.disabled && el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    },
    async finRetiradaSalvar() {
      const f = this.finRetirada;
      if (f.saving || this.adminUser?.role !== 'owner') return;
      const amount = this.finParseValor(f.amount);
      if ((!f.row && (!Number.isFinite(amount) || amount <= 0 || amount > 999999999.99 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7))
          || !f.date || f.date > this.finHoje() || f.reason.trim().length < 3 || (!f.row && f.cash_account.trim().length < 2)) {
        f.error = 'Preencha o valor, a data, a origem do dinheiro e o motivo. Use até duas casas decimais e uma data até hoje.'; return;
      }
      const action = f.row ? 'owner-withdrawal-reversal' : 'owner-withdrawal';
      const target = f.row?.id || 'form';
      const operation = window.PAINEL_INTEGRITY.operation(action, target);
      const body = { occurred_at: this.businessFactInstant(f.date), reason: f.reason.trim(), idempotency_key: operation.key };
      if (!f.row) Object.assign(body, { amount, payment_method: f.payment_method, cash_account: f.cash_account.trim() });
      f.saving = true; f.error = '';
      try {
        await this.apiPost('/admin/api/matriz/financeiro/withdrawals' + (f.row ? '/' + f.row.id + '/reverse' : ''), body);
        window.PAINEL_INTEGRITY.complete(action, target);
        f.open = false;
        opener?.focus();
        this.finRetiradaAviso = f.row ? 'Retirada estornada. O histórico foi preservado.' : 'Retirada registrada. O caixa foi atualizado sem alterar o resultado do mês.';
        await Promise.allSettled([this.loadFinanceiro(), this.loadFinExtrato()]);
      } catch (error) {
        f.error = 'Não foi possível registrar. Confira os dados e tente novamente. Se já foi enviada, atualize os lançamentos antes de tentar outra retirada.';
      } finally { f.saving = false; }
    },
  };
};
