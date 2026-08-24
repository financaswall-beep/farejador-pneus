// Financeiro moderno da unidade. O navegador apresenta os números auditados
// pelo servidor e não recompõe lucro, custo ou caixa por conta própria.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerFinanceiro = function () {
  const ranges = new Set(['today', '7d', '15d', '30d']);
  const money = (value) => {
    if (value === null || value === undefined || value === '') return null;
    let text = String(value).trim().replace(/R\$|\s/g, '');
    if (text.includes(',') && text.includes('.')) text = text.replace(/\./g, '');
    const number = Number(text.replace(',', '.'));
    if (!Number.isFinite(number) || number <= 0
      || Math.abs(number * 100 - Math.round(number * 100)) >= 1e-7) return NaN;
    return Math.round(number * 100) / 100;
  };
  const eventKey = (kind) => 'panel-' + kind + '-' + crypto.randomUUID();
  return {
    partnerFinanceiro: {
      range: '30d', tab: 'visao', loading: false, error: '', partial: false,
      errors: {}, notice: '', request: 0, summary: null, flow: null, simple: null,
      expenses: [], purchases: [], payables: [], receivables: [],
      entries: null, outputs: null, commissions: null, busy: '', actionError: '',
    },

    partnerFinanceiroOwner() {
      return this.isPartnerPanel() && this.panelWorkplace?.role === 'owner';
    },

    async loadPartnerFinanceiro(range = this.partnerFinanceiro.range) {
      if (!this.isPartnerPanel() || !this.hasPanelModule('financeiro')) return;
      const state = this.partnerFinanceiro;
      state.range = ranges.has(range) ? range : '30d';
      const request = ++state.request;
      state.loading = true; state.error = ''; state.partial = false; state.errors = {};
      const specs = [
        ['flow', 'fluxo-caixa', 'one'], ['expenses', 'despesas', 'rows'],
        ['purchases', 'compras', 'rows'], ['payables', 'contas-a-pagar', 'rows'],
        ['receivables', 'contas-a-receber', 'rows'],
      ];
      if (this.partnerFinanceiroOwner() || this.hasPanelModule('resumo')) {
        specs.push(['summary', 'resumo', 'one']);
      }
      if (this.partnerFinanceiroOwner()) {
        const suffix = '?range=' + encodeURIComponent(state.range);
        specs.push(['simple', 'financeiro-simples' + suffix, 'payload']);
        specs.push(['entries', 'financeiro-entradas' + suffix, 'payload']);
        specs.push(['outputs', 'financeiro-saidas' + suffix, 'payload']);
        specs.push(['commissions', 'financeiro-comissoes' + suffix, 'payload']);
      }
      const results = await Promise.allSettled(
        specs.map(([, resource]) => this.partnerApiGet(resource)),
      );
      if (request !== state.request) return;
      results.forEach((result, index) => {
        const [key, , mode] = specs[index];
        if (result.status === 'rejected') {
          state[key] = mode === 'rows' ? [] : null;
          state.errors[key] = this.partnerPanelErrorCode(result.reason);
          return;
        }
        const payload = result.value;
        state[key] = mode === 'rows' ? (Array.isArray(payload.rows) ? payload.rows : [])
          : mode === 'one' ? (payload.rows?.[0] ?? null) : payload;
      });
      const failed = Object.keys(state.errors).length;
      state.partial = failed > 0;
      if (failed === specs.length) {
        state.error = 'Não foi possível carregar o financeiro desta unidade.';
      } else if (failed) {
        state.notice = 'Algumas informações estão temporariamente indisponíveis.';
      }
      state.loading = false;
      this.$nextTick(() => lucide.createIcons());
    },

    partnerFinanceiroSetRange(range) {
      return this.loadPartnerFinanceiro(ranges.has(range) ? range : '30d');
    },

    partnerFinanceiroTruth() {
      const state = this.partnerFinanceiro;
      return {
        competence_month: state.summary?.confirmed_result_month ?? null,
        pending_cost_items_month: state.summary?.pending_cost_items_month ?? null,
        sales_month: state.summary?.sales_month ?? null,
        known_cogs_month: state.summary?.known_cogs_month ?? null,
        expenses_month: state.summary?.expenses_month ?? null,
        cash_month: state.summary?.cash_net_month ?? null,
        cash_range: state.simple?.cash_net ?? null,
        cash_in_range: state.simple?.cash_in ?? null,
        cash_out_range: state.simple?.cash_out ?? null,
        open_receivables: state.summary?.open_receivables_total
          ?? state.simple?.receivable_total ?? null,
        open_payables: state.summary?.open_payables_total ?? null,
      };
    },

    partnerFinanceiroOpenRows(kind) {
      const rows = this.partnerFinanceiro[kind];
      if (!Array.isArray(rows)) return [];
      return rows.filter((row) =>
        row.status === 'open' && Number(row.open_amount ?? row.amount) > 0
      );
    },

    async partnerFinanceiroRun(key, resource, method, body, notice) {
      const state = this.partnerFinanceiro;
      if (state.busy) return false;
      state.busy = key; state.actionError = '';
      try {
        await this.partnerApiWrite(resource, method, body);
        state.notice = notice;
        await this.loadPartnerFinanceiro();
        return true;
      } catch (error) {
        state.actionError = error?.message || 'Não foi possível concluir a operação financeira.';
        return false;
      } finally {
        state.busy = '';
      }
    },

    partnerFinanceiroCreate(kind, input = {}) {
      const amount = money(input.amount);
      const description = String(input.description || '').trim();
      if (!['expense', 'payable', 'receivable'].includes(kind)
          || !description || !(amount > 0)) {
        this.partnerFinanceiro.actionError = 'Revise a descrição e o valor.';
        return false;
      }
      if (kind === 'expense') {
        return this.partnerFinanceiroRun('create:expense', 'despesas', 'POST', {
          expense_date: input.date || null, category: input.category || 'other',
          description, amount,
          payment_method: String(input.payment_method || '').trim() || null,
          idempotency_key: eventKey('expense'),
        }, 'Despesa registrada no caixa da unidade.');
      }
      if (!input.due_date) {
        this.partnerFinanceiro.actionError = 'Informe o vencimento.';
        return false;
      }
      if (kind === 'payable') {
        return this.partnerFinanceiroRun('create:payable', 'contas-a-pagar', 'POST', {
          counterparty_name: String(input.name || '').trim() || null,
          description, category: input.category || 'other', amount,
          due_date: input.due_date, status: 'open', notes: null,
          force_duplicate: false, idempotency_key: eventKey('payable'),
        }, 'Conta a pagar criada.');
      }
      return this.partnerFinanceiroRun('create:receivable', 'contas-a-receber', 'POST', {
        customer_name: String(input.name || '').trim() || null,
        description, source_tag: input.source_tag || 'porta', amount,
        due_date: input.due_date, status: 'open', notes: null,
        idempotency_key: eventKey('receivable'),
      }, 'Conta a receber criada.');
    },

    partnerFinanceiroDelete(kind, row) {
      const resources = {
        expense: 'despesas', payable: 'contas-a-pagar', receivable: 'contas-a-receber',
      };
      if (!row?.id || !resources[kind]
          || (kind === 'payable' && row.managed_by_matrix)
          || (kind === 'receivable' && row.managed_by_sale)) {
        this.partnerFinanceiro.actionError =
          'Este lançamento é administrado pela operação que o originou.';
        return false;
      }
      return this.partnerFinanceiroRun(
        'delete:' + row.id, resources[kind] + '/' + encodeURIComponent(row.id),
        'DELETE', {}, 'Lançamento cancelado com trilha preservada.',
      );
    },

    partnerFinanceiroPay(row, input = {}) {
      if (!row?.id || row.managed_by_matrix) {
        this.partnerFinanceiro.actionError = 'Esta conta é administrada pela Matriz.';
        return false;
      }
      const amount = money(input.amount);
      if (Number.isNaN(amount)) {
        this.partnerFinanceiro.actionError = 'Informe um valor válido.';
        return false;
      }
      return this.partnerFinanceiroRun(
        'pay:' + row.id, 'contas-a-pagar/' + encodeURIComponent(row.id) + '/pagar',
        'POST', {
          paid_at: input.paid_at || null,
          payment_method: String(input.payment_method || '').trim() || null,
          amount, force_duplicate: false, idempotency_key: eventKey('payable'),
        }, 'Pagamento confirmado no caixa da unidade.',
      );
    },

    partnerFinanceiroReceive(row, input = {}) {
      if (!row?.id) return false;
      const amount = money(input.amount);
      if (Number.isNaN(amount)) {
        this.partnerFinanceiro.actionError = 'Informe um valor válido.';
        return false;
      }
      return this.partnerFinanceiroRun(
        'receive:' + row.id,
        'contas-a-receber/' + encodeURIComponent(row.id) + '/receber', 'POST', {
          received_at: input.received_at || null,
          payment_method: String(input.payment_method || '').trim() || null,
          amount, idempotency_key: eventKey('receivable'),
        }, 'Recebimento confirmado no caixa da unidade.',
      );
    },

    partnerFinanceiroEdit(kind, row, changes = {}) {
      const payable = kind === 'payable';
      const receivable = kind === 'receivable';
      if (!row?.id || (!payable && !receivable)
          || (payable && row.managed_by_matrix)
          || (receivable && row.managed_by_sale)) {
        this.partnerFinanceiro.actionError =
          'Este título é administrado pela operação que o originou.';
        return false;
      }
      const data = { ...row, ...changes };
      const amount = money(data.amount);
      if (!String(data.description || '').trim() || !data.due_date || !(amount > 0)) {
        this.partnerFinanceiro.actionError = 'Revise descrição, valor e vencimento.';
        return false;
      }
      const body = payable ? {
        counterparty_name: String(data.counterparty_name || '').trim() || null,
        description: String(data.description).trim(), category: data.category || 'other',
        amount, due_date: data.due_date, notes: String(data.notes || '').trim() || null,
      } : {
        customer_id: data.customer_id || null,
        customer_name: String(data.customer_name || '').trim() || null,
        description: String(data.description).trim(), source_tag: data.source_tag || 'porta',
        amount, due_date: data.due_date, notes: String(data.notes || '').trim() || null,
      };
      const resource = payable ? 'contas-a-pagar' : 'contas-a-receber';
      return this.partnerFinanceiroRun(
        'edit:' + row.id, resource + '/' + encodeURIComponent(row.id),
        'PATCH', body, 'Título atualizado.',
      );
    },

    partnerFinanceiroCredit(action, row, input = {}) {
      if (!this.partnerFinanceiroOwner() || !row?.id
          || !['perda', 'recuperar', 'renegociar'].includes(action)) {
        this.partnerFinanceiro.actionError =
          'Somente o proprietário pode executar esta ação.';
        return false;
      }
      const reason = String(input.reason || '').trim();
      if (reason.length < 3) {
        this.partnerFinanceiro.actionError = 'Informe o motivo com pelo menos 3 caracteres.';
        return false;
      }
      let method = 'POST'; let body;
      if (action === 'renegociar') {
        if (!input.due_date) {
          this.partnerFinanceiro.actionError = 'Informe o novo vencimento.';
          return false;
        }
        method = 'PATCH'; body = { due_date: input.due_date, reason };
      } else {
        const amount = money(input.amount);
        if ((action === 'recuperar' && !(amount > 0)) || Number.isNaN(amount)) {
          this.partnerFinanceiro.actionError = 'Informe um valor válido.';
          return false;
        }
        if (action === 'recuperar' && !String(input.payment_method || '').trim()) {
          this.partnerFinanceiro.actionError = 'Informe como o valor foi recuperado.';
          return false;
        }
        body = action === 'perda'
          ? { occurred_at: input.occurred_at || null, amount, reason,
              idempotency_key: eventKey('loss') }
          : { occurred_at: input.occurred_at || null, amount,
              payment_method: String(input.payment_method || '').trim(),
              note: String(input.note || '').trim() || null,
              idempotency_key: eventKey('recovery') };
      }
      const notice = action === 'perda'
        ? 'Perda registrada por competência, sem entrada no caixa.'
        : action === 'recuperar'
          ? 'Recuperação registrada no caixa.'
          : 'Vencimento renegociado.';
      return this.partnerFinanceiroRun(
        action + ':' + row.id,
        'contas-a-receber/' + encodeURIComponent(row.id) + '/' + action,
        method, body, notice,
      );
    },
  };
};
