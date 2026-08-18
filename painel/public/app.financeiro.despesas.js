// Fatia 07-14 (fiscal 300): sub-aba DESPESAS do Financeiro da matriz (0120/0130) —
// form de lançamento, modalidades vivas do dono, extrato do período e derivados de tela.
// VERBATIM do app.financeiro.js pós-redesign 07-13 (commit 116d712).
// A régua do dinheiro segue no servidor — aqui é só agrupamento pra exibir.
// Montado via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.financeiroDespesas = function () {
  return {
    despesaLabel(catId) {
      const c = this.despesaCategorias.find((x) => x.id === catId);
      return c ? c.label : catId;
    },
    // ── Sub-aba Despesas (redesign 07-13, desenho do dono): derivados de TELA ──
    // Soma/conta o que a tela JÁ carregou (entries do período + agenda da visão).
    despesaPorModalidade() {
      const mapa = new Map();
      for (const d of (this.matrizDespesas?.entries || [])) {
        const atual = mapa.get(d.category) || { total: 0, count: 0 };
        atual.total += Number(d.amount || 0);
        atual.count += 1;
        mapa.set(d.category, atual);
      }
      return [...mapa.entries()]
        .map(([id, v]) => ({ id, label: this.despesaLabel(id), total: v.total, count: v.count }))
        .sort((a, b) => b.total - a.total);
    },
    despesaModBarW(total) {
      const linhas = this.despesaPorModalidade();
      const max = linhas.length ? linhas[0].total : 0;
      if (!(max > 0) || !(Number(total) > 0)) return '0%';
      return Math.max(2, Math.round((Number(total) / max) * 100)) + '%';
    },
    // Caíram em "Outros" no período — o balde genérico que o dono quer esvaziar (0130).
    despesaOutrosCount() {
      return (this.matrizDespesas?.entries || []).filter((d) => d.category === 'outros').length;
    },
    // ── Modalidades vivas (0130): fábrica + as do dono; arquivada some do form ──
    despesaMesAtual() {
      // Mês corrente no fuso da operação (SP) — toISOString viraria o mês mais cedo à noite.
      return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' })
        .format(new Date()).slice(0, 7);
    },
    despesaCatAtivas() {
      return this.despesaCategorias.filter((c) => !c.archived);
    },
    despesaCatCustom() {
      return this.despesaCategorias.filter((c) => !c.archived && c.is_system === false);
    },
    despesaFiltroMudou() {
      void this.loadDespesas();
    },
    // Opção "➕ Nova modalidade…" do select: cria e já deixa selecionada no form.
    despesaCatSelect() {
      if (this.despesaForm.category !== '__nova__') return;
      this.despesaForm.category = 'outros';
      void this.despesaNovaCategoria();
    },
    async despesaNovaCategoria() {
      const nome = window.prompt('Nome da nova modalidade de despesa (ex.: Pedágio, Alimentação):');
      if (!nome || !nome.trim()) return;
      try {
        const res = await this.apiPost('/admin/api/matriz/despesas/categorias', { label: nome.trim() });
        await this.loadDespesas();
        if (res && res.id) this.despesaForm.category = res.id;
        this.despesaMsg = { ok: true, text: `Modalidade "${res.label}" pronta — já dá pra lançar nela.` };
      } catch (err) {
        const txt = String(err.message || '').includes('category_exists')
          ? 'Já existe uma modalidade com esse nome.'
          : String(err.message || '').includes('category_label_invalid')
            ? 'Nome muito curto — usa pelo menos 2 letras.'
            : `Não consegui criar (${err.message}).`;
        this.despesaMsg = { ok: false, text: txt };
      }
    },
    async despesaArquivarCategoria(c) {
      if (!window.confirm(`Arquivar a modalidade "${c.label}"? As despesas antigas continuam nas contas — ela só sai do formulário (dá pra reativar criando com o mesmo nome).`)) return;
      try {
        await this.apiPost('/admin/api/matriz/despesas/categorias/arquivar', { slug: c.id });
        if (this.despesaForm.category === c.id) this.despesaForm.category = 'outros';
        if (this.despesaFiltro.categoria === c.id) this.despesaFiltro.categoria = '';
        await this.loadDespesas();
      } catch (err) {
        window.alert(`Não consegui arquivar (${err.message}).`);
      }
    },
    async despesaSubmit() {
      const valor = this.finParseValor(this.despesaForm.amount);
      if (!valor || valor <= 0) {
        this.despesaMsg = { ok: false, text: 'Valor da despesa precisa ser maior que zero.' };
        return;
      }
      if (this.despesaForm.payment_status === 'pending' && !this.despesaForm.due_date) {
        this.despesaMsg = { ok: false, text: 'Informe o vencimento da despesa a pagar.' };
        return;
      }
      this.despesaSaving = true;
      this.despesaMsg = null;
      try {
        const body = {
          category: this.despesaForm.category,
          description: this.despesaForm.description.trim() || null,
          amount: valor,
          payment_status: this.despesaForm.payment_status,
        };
        const occurredDate = this.despesaForm.occurred_at || this.finHoje();
        const paymentDate = this.despesaForm.payment_date || occurredDate;
        body.occurred_at = this.businessFactInstant(occurredDate);
        body.document_date = this.despesaForm.document_date || occurredDate;
        body.competence_month = `${this.despesaForm.competence_month || occurredDate.slice(0, 7)}-01`;
        if (body.payment_status === 'paid') {
          body.paid_at = this.businessFactInstant(paymentDate);
        }
        this.despesaForm.idempotency_key = this.despesaForm.idempotency_key
          || window.PAINEL_INTEGRITY.operation('matriz-expense-create', 'form').key;
        body.idempotency_key = this.despesaForm.idempotency_key;
        if (body.payment_status === 'pending' && this.despesaForm.due_date) {
          body.due_date = this.despesaForm.due_date;
        }
        await this.apiPost('/admin/api/matriz/despesas', body);
        const fiadoTxt = body.payment_status === 'pending' ? ' (foi pro A PAGAR)' : '';
        this.despesaMsg = { ok: true, text: `Despesa lançada — ${this.formatCurrency(valor)}${fiadoTxt}.` };
        window.PAINEL_INTEGRITY.complete('matriz-expense-create', 'form');
        this.despesaForm = {
          category: 'outros', description: '', amount: '', payment_status: 'paid',
          occurred_at: '', document_date: '', competence_month: '',
          payment_date: '', due_date: '', idempotency_key: '',
        };
        await this.loadFinanceiro();
      } catch (err) {
        this.despesaMsg = { ok: false, text: `Não consegui lançar (${err.message}).` };
      } finally {
        this.despesaSaving = false;
      }
    },
    despesaSettle(row) {
      this.finPagar({
        tipo: row.payroll_item_id ? 'folha' : 'despesa',
        id: row.id,
        nome: row.description || this.despesaLabel(row.category),
        valor: row.amount,
        due_date: row.due_date,
        settlement_mode: 'expense',
      });
    },
    despesaRemove(row) {
      if (this.despesaRemoveDialog?.saving) return;
      this.despesaRemoveDialog = {
        open: true, row, reason: '', error: null, saving: false,
      };
      this.$nextTick(() => {
        window.lucide && window.lucide.createIcons();
        this.$refs?.despesaRemoveReason?.focus();
      });
    },
    despesaFecharRemocao(force = false) {
      if (this.despesaRemoveDialog?.saving && !force) return;
      this.despesaRemoveDialog = {
        open: false, row: null, reason: '', error: null, saving: false,
      };
    },
    async despesaConfirmarRemocao() {
      const dialog = this.despesaRemoveDialog;
      const row = dialog?.row;
      if (!row || dialog.saving) return;
      const reason = String(dialog.reason || '').trim();
      if (reason.length < 2) {
        dialog.error = 'Informe um motivo com pelo menos 2 caracteres.';
        return;
      }
      const operation = window.PAINEL_INTEGRITY.operation('matriz-expense-remove', row.id);
      operation.reason = reason;
      window.PAINEL_INTEGRITY.save();
      dialog.saving = true;
      dialog.error = null;
      try {
        await this.apiPost('/admin/api/matriz/despesas/remove', {
          id: row.id, reason, idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('matriz-expense-remove', row.id);
        this.despesaFecharRemocao(true);
        this.despesaMsg = {
          ok: true,
          text: 'Despesa removida. A trilha de auditoria foi preservada.',
        };
        await this.loadFinanceiro();
      } catch (err) {
        dialog.error = `Não consegui remover (${err.message}).`;
      } finally {
        if (this.despesaRemoveDialog === dialog) dialog.saving = false;
      }
    },
  };
};
