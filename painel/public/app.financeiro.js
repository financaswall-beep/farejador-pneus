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
    // "Cobrar no WhatsApp" da tela Financeiro (mesmo deep-link wa.me da página Rede).
    finGiroTexto() {
      const ind = this.financeiroVisao && this.financeiroVisao.indicadores;
      if (!ind || ind.giro_dias === null || ind.giro_dias === undefined) return '—';
      const dias = Number(ind.giro_dias);
      if (!(dias > 0)) return '—';
      const vezes = Math.round((30 / dias) * 10) / 10;
      return String(vezes).replace('.', ',') + 'x';
    },
    // ── Sub-aba Cobranças: derivados da lista real a_receber.itens ──
    // Sub-aba Indicadores: somente derivados do payload financeiro real.
    // Não cria série histórica nem prazo médio que o backend ainda não mede.
    finIndicadoresPainel() {
      const v = this.financeiroVisao;
      if (!v) return null;
      const m = v.mes;
      const ind = v.indicadores;
      const faturamento = Number(m.faturamento || 0);
      const custo = Number(m.custo || 0);
      const despesas = Number(m.despesas || 0);
      const lucro = Number(m.lucro || 0);
      const margem = m.margem_pct === null ? null : Number(m.margem_pct);
      const pontoEquilibrio = ind.ponto_equilibrio === null ? null : Number(ind.ponto_equilibrio);
      const pontoPct = pontoEquilibrio && pontoEquilibrio > 0
        ? Math.round((faturamento / pontoEquilibrio) * 1000) / 10
        : null;
      const receber = Number(v.a_receber.total || 0);
      const pagar = Number(v.a_pagar.total || 0);
      const saldoAberto = receber - pagar;
      const cobertura = pagar > 0 ? Math.round((receber / pagar) * 100) / 100 : null;
      const maxResultado = Math.max(faturamento, custo, despesas, Math.abs(lucro), 1);
      const resultados = [
        { label: 'Faturamento', valor: faturamento, pct: (faturamento / maxResultado) * 100, cls: 'bg-emerald-700' },
        { label: 'Custo dos pneus', valor: custo, pct: (custo / maxResultado) * 100, cls: 'bg-gray-400' },
        { label: 'Despesas', valor: despesas, pct: (despesas / maxResultado) * 100, cls: 'bg-rose-400' },
        { label: lucro >= 0 ? 'Lucro' : 'Prejuízo', valor: lucro, pct: (Math.abs(lucro) / maxResultado) * 100, cls: lucro >= 0 ? 'bg-emerald-500' : 'bg-rose-600' },
      ];
      const fontesBase = [
        { label: 'Atacado', valor: Number(m.pernas.atacado.faturamento || 0), lucro: Number(m.pernas.atacado.lucro || 0) },
        { label: 'Varejo (bot + balcão)', valor: Number(m.pernas.varejo.faturamento || 0), lucro: Number(m.pernas.varejo.lucro || 0) },
        { label: 'Frete', valor: Number(m.pernas.frete?.recebido || 0), lucro: Number(m.pernas.frete?.recebido || 0) },
        { label: 'Comissão da rede', valor: Number(m.pernas.comissao?.realizado || 0), lucro: Number(m.pernas.comissao?.realizado || 0) },
      ];
      const fontes = fontesBase.map((item) => {
        const margemFonte = this.finPctLucro(item.valor, item.lucro);
        return { ...item, margem: margemFonte, barra: margemFonte === null ? 0 : Math.max(0, Math.min(100, margemFonte)) };
      });
      const vencidos = Number(v.a_receber.vencidos_count || 0) + Number(v.a_pagar.vencidos_count || 0);
      const saudavel = lucro >= 0 && (pontoPct === null || pontoPct >= 100) && vencidos === 0;
      const critico = lucro < 0;
      const saude = {
        label: critico ? 'Resultado negativo' : saudavel ? 'Saudável' : 'Pede atenção',
        cls: critico ? 'text-rose-600' : saudavel ? 'text-emerald-700' : 'text-amber-600',
        bg: critico ? 'bg-rose-50' : saudavel ? 'bg-emerald-50' : 'bg-amber-50',
      };
      return {
        lucro, margem, pontoEquilibrio, pontoPct,
        receber, pagar, saldoAberto, cobertura, resultados, fontes, vencidos, saude,
      };
    },
    // Indicadores > Fluxo de caixa: projecao honesta feita somente com titulos
    // abertos que ja possuem vencimento. Nao chama resultado de saldo bancario.
    finFluxoItens() {
      const v = this.financeiroVisao;
      if (!v) return [];
      const receber = (v.a_receber.itens || []).map((item) => ({
        ...item,
        direcao: 'entrada',
        origem: item.tipo === 'comissao' ? 'Comissao da rede' : 'Venda atacado',
        descricao: item.nome,
        dias: this.cobrancaDias(item.due_date),
      }));
      const pagar = (v.a_pagar.itens || []).map((item) => ({
        ...item,
        direcao: 'saida',
        origem: item.tipo === 'despesa' ? 'Despesa da Matriz' : 'Fornecedor',
        descricao: item.nome,
        dias: this.cobrancaDias(item.due_date),
      }));
      return [...receber, ...pagar].sort((a, b) => {
        if (a.dias === null && b.dias === null) return Number(b.valor) - Number(a.valor);
        if (a.dias === null) return 1;
        if (b.dias === null) return -1;
        return a.dias - b.dias || Number(b.valor) - Number(a.valor);
      });
    },
    finFluxoStatus(item) {
      if (item.dias === null) return { label: 'Sem vencimento', cls: 'bg-gray-100 text-gray-600' };
      if (item.dias < 0) return { label: 'Vencido', cls: 'bg-rose-50 text-rose-600' };
      if (item.dias === 0) return { label: 'Vence hoje', cls: 'bg-amber-50 text-amber-700' };
      if (item.dias <= 7) return { label: 'Proximos 7 dias', cls: 'bg-emerald-50 text-emerald-700' };
      return { label: 'Previsto', cls: 'bg-gray-100 text-gray-600' };
    },
    finFluxoPainel() {
      const v = this.financeiroVisao;
      if (!v) return null;
      const horizonte = [7, 30, 90].includes(Number(this.finFluxoDias)) ? Number(this.finFluxoDias) : 30;
      const itens = this.finFluxoItens();
      const noHorizonte = itens.filter((item) => item.dias !== null && item.dias <= horizonte);
      const entradas = noHorizonte.filter((item) => item.direcao === 'entrada').reduce((s, item) => s + Number(item.valor || 0), 0);
      const saidas = noHorizonte.filter((item) => item.direcao === 'saida').reduce((s, item) => s + Number(item.valor || 0), 0);
      const resultado = Number(v.mes.lucro || 0);
      const impacto = entradas - saidas;
      const defs = horizonte === 7
        ? [
            { label: 'Vencidos', min: -Infinity, max: -1 },
            { label: 'Hoje', min: 0, max: 0 },
            { label: '1 a 3 dias', min: 1, max: 3 },
            { label: '4 a 7 dias', min: 4, max: 7 },
          ]
        : horizonte === 90
          ? [
              { label: 'Vencidos', min: -Infinity, max: -1 },
              { label: 'Hoje', min: 0, max: 0 },
              { label: '1 a 7 dias', min: 1, max: 7 },
              { label: '8 a 30 dias', min: 8, max: 30 },
              { label: '31 a 60 dias', min: 31, max: 60 },
              { label: '61 a 90 dias', min: 61, max: 90 },
            ]
          : [
              { label: 'Vencidos', min: -Infinity, max: -1 },
              { label: 'Hoje', min: 0, max: 0 },
              { label: '1 a 7 dias', min: 1, max: 7 },
              { label: '8 a 15 dias', min: 8, max: 15 },
              { label: '16 a 30 dias', min: 16, max: 30 },
            ];
      const buckets = defs.map((def) => {
        const rows = itens.filter((item) => item.dias !== null && item.dias >= def.min && item.dias <= def.max);
        return {
          label: def.label,
          entrada: rows.filter((item) => item.direcao === 'entrada').reduce((s, item) => s + Number(item.valor || 0), 0),
          saida: rows.filter((item) => item.direcao === 'saida').reduce((s, item) => s + Number(item.valor || 0), 0),
        };
      });
      const semData = itens.filter((item) => item.dias === null);
      buckets.push({
        label: 'Sem data',
        entrada: semData.filter((item) => item.direcao === 'entrada').reduce((s, item) => s + Number(item.valor || 0), 0),
        saida: semData.filter((item) => item.direcao === 'saida').reduce((s, item) => s + Number(item.valor || 0), 0),
      });
      const maxBar = Math.max(1, ...buckets.flatMap((b) => [b.entrada, b.saida]));
      for (const bucket of buckets) {
        bucket.entradaPct = bucket.entrada > 0 ? Math.max(5, Math.round((bucket.entrada / maxBar) * 100)) : 0;
        bucket.saidaPct = bucket.saida > 0 ? Math.max(5, Math.round((bucket.saida / maxBar) * 100)) : 0;
      }
      const vencidos = itens.filter((item) => item.dias !== null && item.dias < 0);
      const amanha = itens.filter((item) => item.dias === 1);
      return {
        horizonte, resultado, entradas, saidas, impacto,
        buckets,
        movimentos: itens.filter((item) => item.dias === null || item.dias <= horizonte).slice(0, 8),
        vencidosTotal: vencidos.reduce((s, item) => s + Number(item.valor || 0), 0),
        vencidosCount: vencidos.length,
        amanhaTotal: amanha.reduce((s, item) => s + Number(item.valor || 0), 0),
        amanhaCount: amanha.length,
        semDataTotal: semData.reduce((s, item) => s + Number(item.valor || 0), 0),
        semDataCount: semData.length,
      };
    },
    finAtrasosPainel() {
      const itens = this.finFluxoItens().filter((item) => item.dias !== null && item.dias < 0);
      const defs = [
        { label: '1 a 7 dias', min: 1, max: 7 },
        { label: '8 a 30 dias', min: 8, max: 30 },
        { label: 'Mais de 30 dias', min: 31, max: Infinity },
      ];
      const faixas = defs.map((def) => {
        const rows = itens.filter((item) => -item.dias >= def.min && -item.dias <= def.max);
        const receber = rows.filter((item) => item.direcao === 'entrada').reduce((s, item) => s + Number(item.valor || 0), 0);
        const pagar = rows.filter((item) => item.direcao === 'saida').reduce((s, item) => s + Number(item.valor || 0), 0);
        return { label: def.label, receber, pagar, count: rows.length };
      });
      const max = Math.max(1, ...faixas.flatMap((f) => [f.receber, f.pagar]));
      for (const faixa of faixas) {
        faixa.receberPct = faixa.receber > 0 ? Math.max(3, Math.round((faixa.receber / max) * 100)) : 0;
        faixa.pagarPct = faixa.pagar > 0 ? Math.max(3, Math.round((faixa.pagar / max) * 100)) : 0;
      }
      const receber = itens.filter((item) => item.direcao === 'entrada');
      const pagar = itens.filter((item) => item.direcao === 'saida');
      return {
        faixas,
        receberTotal: receber.reduce((s, item) => s + Number(item.valor || 0), 0),
        receberCount: receber.length,
        pagarTotal: pagar.reduce((s, item) => s + Number(item.valor || 0), 0),
        pagarCount: pagar.length,
        itens,
      };
    },
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
        if (item.tipo === 'despesa') {
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
    despesaLabel(catId) {
      const c = this.despesaCategorias.find((x) => x.id === catId);
      return c ? c.label : catId;
    },
    // ── Sub-aba Despesas (redesign 07-13, desenho do dono): derivados de TELA ──
    // Soma/conta o que a tela JÁ carregou (entries do período + agenda da visão);
    // a régua do dinheiro segue no servidor — aqui é só agrupamento pra exibir.
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
      if (this.finQuitando) return; // trava: 2º clique não dispara 2º settle (nem erro à toa)
      if (!window.confirm(`Pagar ${this.formatCurrency(Number(row.amount))} (${this.despesaLabel(row.category)})?`)) return;
      this.finQuitando = true;
      try {
        await this.apiPost('/admin/api/matriz/despesas/settle', { id: row.id });
        await this.loadFinanceiro();
        await this.loadSino(); // sino atualiza NA HORA (não espera o ciclo de 15s)
      } catch (err) {
        window.alert(`Não consegui quitar (${err.message}). Recarrega a página e tenta de novo.`);
      } finally {
        this.finQuitando = false;
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
