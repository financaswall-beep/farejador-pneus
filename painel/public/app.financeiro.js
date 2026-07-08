// Obra 300 (2026-07-05): fatia do painel da MATRIZ — aba Financeiro (visão 3 pernas) + despesas (0120).
// VERBATIM das linhas 1630-1743 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.financeiro = function () {
  return {
    finBarWidth(valor) {
      const v = this.financeiroVisao;
      if (!v) return '0%';
      const candidatos = [
        Number(v.mes.pernas.atacado.faturamento || 0),
        Number(v.mes.pernas.varejo.faturamento || 0),
        Number(v.mes.pernas.comissao?.realizado || 0),
        Number(v.mes.pernas.frete?.recebido || 0),
        Number(v.mes.despesas || 0),
      ];
      const max = Math.max(...candidatos);
      if (!(max > 0) || !(Number(valor) > 0)) return '0%';
      return Math.max(2, Math.round((Number(valor) / max) * 100)) + '%';
    },
    // "Cobrar no WhatsApp" da tela Financeiro (mesmo deep-link wa.me da página Rede).
    finWhatsLink(item) {
      const digits = String(item.phone || '').replace(/\D/g, '');
      if (!digits) return null;
      const tel = digits.startsWith('55') ? digits : '55' + digits;
      const msg = item.tipo === 'comissao'
        ? 'Fala! Fechou ' + this.formatCurrency(Number(item.valor || 0)) +
          ' de comissão das vendas que o Farejador mandou pra você. Como prefere acertar?'
        : 'Fala! Tem ' + this.formatCurrency(Number(item.valor || 0)) +
          ' em aberto aqui do pneu que você levou no atacado' +
          (item.overdue ? ' (já venceu)' : '') + '. Como prefere acertar?';
      return 'https://wa.me/' + tel + '?text=' + encodeURIComponent(msg);
    },
    // Rótulo de vencimento dos itens (a receber/agenda).
    finVence(item) {
      if (item.tipo === 'comissao') return (item.count || 0) + ' venda(s) da rede';
      if (!item.due_date) return 'sem vencimento';
      return (item.overdue ? 'VENCEU ' : 'vence ') + this.financeDate(item.due_date);
    },
    // "Recebi" direto da tela: fiado quita a venda; comissão quita o acumulado do parceiro.
    async finReceber(item) {
      const rotulo = item.tipo === 'comissao' ? 'a comissão de ' + item.nome : 'de ' + item.nome;
      if (!window.confirm(`Recebeu ${this.formatCurrency(Number(item.valor))} ${rotulo}?`)) return;
      try {
        if (item.tipo === 'comissao') {
          await this.apiPost('/admin/api/rede/comissoes/settle', { partner_id: item.id });
        } else {
          await this.apiPost('/admin/api/wholesale/finance/settle', { kind: 'sale', id: item.id });
        }
        await this.loadFinanceiro();
      } catch (err) {
        window.alert(`Não consegui quitar (${err.message}). Recarrega a página e tenta de novo.`);
      }
    },
    // "Paguei" direto da agenda: fornecedor quita a compra; despesa quita a despesa.
    async finPagar(item) {
      if (!window.confirm(`Pagar ${this.formatCurrency(Number(item.valor))} (${item.nome})?`)) return;
      try {
        if (item.tipo === 'despesa') {
          await this.apiPost('/admin/api/matriz/despesas/settle', { id: item.id });
        } else {
          await this.apiPost('/admin/api/wholesale/finance/settle', { kind: 'purchase', id: item.id });
        }
        await this.loadFinanceiro();
      } catch (err) {
        window.alert(`Não consegui quitar (${err.message}). Recarrega a página e tenta de novo.`);
      }
    },
    despesaLabel(catId) {
      const c = this.despesaCategorias.find((x) => x.id === catId);
      return c ? c.label : catId;
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
      const valor = Number(String(this.despesaForm.amount).replace(',', '.'));
      if (!valor || valor <= 0) {
        this.despesaMsg = { ok: false, text: 'Valor da despesa precisa ser maior que zero.' };
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
        if (body.payment_status === 'pending' && this.despesaForm.due_date) {
          body.due_date = this.despesaForm.due_date;
        }
        await this.apiPost('/admin/api/matriz/despesas', body);
        const fiadoTxt = body.payment_status === 'pending' ? ' (foi pro A PAGAR)' : '';
        this.despesaMsg = { ok: true, text: `Despesa lançada — ${this.formatCurrency(valor)}${fiadoTxt}.` };
        this.despesaForm = { category: 'outros', description: '', amount: '', payment_status: 'paid', due_date: '' };
        await this.loadFinanceiro();
      } catch (err) {
        this.despesaMsg = { ok: false, text: `Não consegui lançar (${err.message}).` };
      } finally {
        this.despesaSaving = false;
      }
    },
    async despesaSettle(row) {
      if (!window.confirm(`Pagar ${this.formatCurrency(Number(row.amount))} (${this.despesaLabel(row.category)})?`)) return;
      try {
        await this.apiPost('/admin/api/matriz/despesas/settle', { id: row.id });
        await this.loadFinanceiro();
      } catch (err) {
        window.alert(`Não consegui quitar (${err.message}). Recarrega a página e tenta de novo.`);
      }
    },
    async despesaRemove(row) {
      if (!window.confirm(`Remover a despesa de ${this.formatCurrency(Number(row.amount))} (${this.despesaLabel(row.category)})? Ela some das contas (a trilha fica no banco).`)) return;
      try {
        await this.apiPost('/admin/api/matriz/despesas/remove', { id: row.id });
        await this.loadFinanceiro();
      } catch (err) {
        window.alert(`Não consegui remover (${err.message}).`);
      }
    },

    // ── ATACADO (Fase 2) — estoque do galpão por medida ──
  };
};
