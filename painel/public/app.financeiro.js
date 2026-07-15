// Obra 300 (2026-07-05): fatia do painel da MATRIZ — aba Financeiro (visão 3 pernas).
// Fatia 07-14 (fiscal 300): o redesign 07-13 engordou este arquivo pra 522 linhas; os
// assuntos INDICADORES (fluxo/análise/inadimplência) e DESPESAS saíram pra
// app.financeiro.indicadores.js e app.financeiro.despesas.js. Aqui ficam a Visão
// geral, a sub-aba Cobranças e as ações Recebi/Paguei (usadas pelas 3 telas).
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

    // ── redesign 07-12 (desenho do dono): helpers da Visão geral em sub-abas ──
    // Lucro BRUTO por fonte. Atacado/varejo têm custo de pneu congelado; frete e
    // comissão não têm custo de pneu (o custo do frete — gasolina — já mora na perna
    // Despesas), então o recebido É o lucro bruto. Fecha a conta: Σ bruto − despesas = lucro.
    finLucroPerna(chave) {
      const p = this.financeiroVisao && this.financeiroVisao.mes.pernas;
      if (!p) return 0;
      if (chave === 'atacado') return Number(p.atacado.lucro || 0);
      if (chave === 'varejo') return Number(p.varejo.lucro || 0);
      if (chave === 'frete') return Number((p.frete && p.frete.recebido) || 0);
      if (chave === 'comissao') return Number((p.comissao && p.comissao.realizado) || 0);
      return 0;
    },
    finPctLucro(valor, lucro) {
      const v = Number(valor || 0);
      if (!(v > 0)) return null;
      return Math.round((Number(lucro || 0) / v) * 1000) / 10;
    },
    // Barra "Resultado do período": o que ENTROU partido em custo / despesa / lucro.
    finResSeg(qual) {
      const m = this.financeiroVisao && this.financeiroVisao.mes;
      if (!m) return '0%';
      const entrou = Number(m.faturamento || 0);
      if (!(entrou > 0)) return '0%';
      const val = qual === 'custo' ? Number(m.custo || 0)
        : qual === 'despesa' ? Number(m.despesas || 0)
        : Math.max(0, Number(m.lucro || 0));
      return (Math.round((val / entrou) * 1000) / 10) + '%';
    },
    // % de cada componente (rótulo embaixo da barra).
    finResPct(qual) {
      const m = this.financeiroVisao && this.financeiroVisao.mes;
      if (!m) return 0;
      const entrou = Number(m.faturamento || 0);
      if (!(entrou > 0)) return 0;
      const val = qual === 'custo' ? Number(m.custo || 0)
        : qual === 'despesa' ? Number(m.despesas || 0)
        : Math.max(0, Number(m.lucro || 0));
      return Math.round((val / entrou) * 1000) / 10;
    },
    // Contadores da "Atenção rápida" (levam pras sub-abas / estoque).
    finCobrancasAbertas() {
      return (this.financeiroVisao && this.financeiroVisao.a_receber.itens.length) || 0;
    },

    // ── Sub-aba Cobranças: derivados da lista real a_receber.itens ──
    cobrancaDias(due) {
      if (!due) return null;
      const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const alvo = String(due).slice(0, 10);
      return Math.round((new Date(alvo + 'T00:00:00Z') - new Date(hoje + 'T00:00:00Z')) / 86400000);
    },
    cobrancaClasse(item) {
      if (item.tipo === 'comissao') return 'comissao';
      if (item.overdue) return 'vencida';
      const dias = this.cobrancaDias(item.due_date);
      if (dias === null) return 'aberta';
      if (dias < 0) return 'vencida';
      if (dias === 0) return 'hoje';
      if (dias <= 7) return 'sete';
      return 'aberta';
    },
    cobrancaOrigem(item) {
      return item.tipo === 'comissao' ? 'Comissão da rede' : 'Fiado atacado';
    },
    cobrancaSemTelefone(item) {
      return !String(item.phone || '').replace(/\D/g, '');
    },
    cobrancaStatus(item) {
      const classe = this.cobrancaClasse(item);
      if (classe === 'comissao') {
        const qtd = Number(item.count || 0);
        return { label: qtd + ' venda' + (qtd === 1 ? '' : 's'), cls: 'bg-emerald-50 text-emerald-700 font-medium' };
      }
      if (classe === 'vencida') return { label: item.due_date ? 'Venceu ' + this.financeDate(item.due_date) : 'Vencida', cls: 'bg-rose-50 text-rose-600 font-semibold' };
      if (classe === 'hoje') return { label: 'Vence hoje', cls: 'bg-amber-50 text-amber-700 font-medium' };
      if (classe === 'sete') return { label: 'Próx. 7 dias', cls: 'bg-emerald-50 text-emerald-700 font-medium' };
      return { label: 'Em aberto', cls: 'bg-gray-100 text-gray-600 font-medium' };
    },
    cobrancaFila() {
      const itens = (this.financeiroVisao && this.financeiroVisao.a_receber.itens) || [];
      const filtro = this.cobrancaFiltro || '';
      if (!filtro) return itens;
      if (filtro === 'semfone') return itens.filter((item) => this.cobrancaSemTelefone(item));
      if (filtro === 'comissao') return itens.filter((item) => item.tipo === 'comissao');
      return itens.filter((item) => this.cobrancaClasse(item) === filtro);
    },
    cobrancaPainel() {
      const itens = (this.financeiroVisao && this.financeiroVisao.a_receber.itens) || [];
      const cards = {
        vencidas: { total: 0, count: 0 }, hoje: { total: 0, count: 0 },
        sete: { total: 0, count: 0 }, comissao: { total: 0, count: 0 },
        aberto: { total: 0, count: 0 }, semfone: { total: 0, count: 0 },
        semdata: { total: 0, count: 0 },
      };
      const origemMap = new Map();
      for (const item of itens) {
        const valor = Number(item.valor || 0);
        const classe = this.cobrancaClasse(item);
        cards.aberto.total += valor;
        cards.aberto.count += 1;
        if (cards[classe]) {
          cards[classe].total += valor;
          cards[classe].count += 1;
        }
        if (this.cobrancaSemTelefone(item)) {
          cards.semfone.total += valor;
          cards.semfone.count += 1;
        }
        if (!item.due_date || item.tipo === 'comissao') {
          cards.semdata.total += valor;
          cards.semdata.count += 1;
        }
        const origem = this.cobrancaOrigem(item);
        const atual = origemMap.get(origem) || { label: origem, total: 0, count: 0 };
        atual.total += valor;
        atual.count += 1;
        origemMap.set(origem, atual);
      }
      const origens = [...origemMap.values()]
        .sort((a, b) => b.total - a.total)
        .map((item) => ({ ...item, pct: cards.aberto.total > 0 ? Math.round((item.total / cards.aberto.total) * 1000) / 10 : 0 }));
      return { cards, origens };
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
      if (this.finQuitando) return; // trava: 2º clique não dispara 2º settle (nem erro à toa)
      const rotulo = item.tipo === 'comissao' ? 'a comissão de ' + item.nome : 'de ' + item.nome;
      if (!window.confirm(`Recebeu ${this.formatCurrency(Number(item.valor))} ${rotulo}?`)) return;
      this.finQuitando = true;
      try {
        if (item.tipo === 'comissao') {
          await this.apiPost('/admin/api/rede/comissoes/settle', { partner_id: item.id });
        } else {
          await this.apiPost('/admin/api/wholesale/finance/settle', { kind: 'sale', id: item.id });
        }
        await this.loadFinanceiro();
        await this.loadSino(); // sino atualiza NA HORA (não espera o ciclo de 15s)
      } catch (err) {
        window.alert(`Não consegui quitar (${err.message}). Recarrega a página e tenta de novo.`);
      } finally {
        this.finQuitando = false;
      }
    },
    // "Paguei" direto da agenda: fornecedor quita a compra; despesa quita a despesa.
    async finPagar(item) {
      if (this.finQuitando) return; // trava: 2º clique não dispara 2º settle (nem erro à toa)
      if (!window.confirm(`Pagar ${this.formatCurrency(Number(item.valor))} (${item.nome})?`)) return;
      this.finQuitando = true;
      try {
        if (item.tipo === 'despesa' || item.tipo === 'folha') {
          await this.apiPost('/admin/api/matriz/despesas/settle', { id: item.id });
        } else {
          await this.apiPost('/admin/api/wholesale/finance/settle', { kind: 'purchase', id: item.id });
        }
        await this.loadFinanceiro();
        await this.loadSino(); // sino atualiza NA HORA (não espera o ciclo de 15s)
      } catch (err) {
        window.alert(`Não consegui quitar (${err.message}). Recarrega a página e tenta de novo.`);
      } finally {
        this.finQuitando = false;
      }
    },
  };
};
