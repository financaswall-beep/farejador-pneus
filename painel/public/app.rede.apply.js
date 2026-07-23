// Obra 300 (2026-07-05): fatia do painel da MATRIZ — mapeadores do payload da Rede (applyRede/applyMatrizResumo).
// VERBATIM das linhas 1860-2097 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.redeApply = function () {
  return {
    applyProdutos(rows) {
      this.produtos = rows || [];
    },

    // Resumo do dono: bot/tráfego (analytics, read-only) + leads a recuperar.
    applyMatrizResumo(data) {
      const m = (data && data.metrics) || {};
      this.kpis = [
        { label: 'Conversas', value: String(m.conversas || 0), delta: `${m.fecharam || 0} fecharam`, deltaClass: 'bg-blue-50 text-blue-700', icon: 'message-circle', iconBg: 'bg-blue-100', iconColor: 'text-blue-700' },
        { label: 'Conversão', value: `${Number(m.taxa_conversao || 0)}%`, delta: `${m.abandonaram || 0} largaram`, deltaClass: 'bg-emerald-50 text-emerald-700', icon: 'trending-up', iconBg: 'bg-emerald-100', iconColor: 'text-emerald-700' },
        { label: 'Faturamento via bot', value: this.formatCurrency(m.faturamento), delta: `ticket ${this.formatCurrency(m.ticket_medio)}`, deltaClass: 'bg-purple-50 text-purple-700', icon: 'wallet', iconBg: 'bg-purple-100', iconColor: 'text-purple-700' },
        { label: 'Custo do bot', value: this.formatCurrency(m.custo_bot), delta: 'IA no período', deltaClass: 'bg-amber-50 text-amber-700', icon: 'bot', iconBg: 'bg-amber-100', iconColor: 'text-amber-700' },
      ];
      this.leadsRecuperar = ((data && data.leads) || []).map((l) => ({
        nome: l.cliente_nome || 'Sem nome',
        telefone: l.cliente_telefone || '-',
        moto: l.moto || '-',
        bairro: l.bairro || '-',
        preco: l.ultimo_preco_cotado || null,
        motivo: l.provavel_motivo || l.etapa_atingida || 'sem motivo',
        horas: l.horas != null ? Math.round(Number(l.horas)) : null,
        reclamouPreco: !!l.reclamou_preco,
        concorrente: !!l.mencionou_concorrente,
      }));
      this.resumoSeries = ((data && data.series) || []).map((s) => ({
        dia: s.dia,
        conversas: Number(s.conversas || 0),
        faturamento: Number(s.faturamento || 0),
      }));
    },

    partnerStatusLabel(status) {
      if (status === 'active') return 'Ativo';
      if (status === 'suspended') return 'Suspenso';
      return 'Credenciamento';
    },

    partnerCommercialModel(row) {
      const model = row.commercial_model === 'monthly'
        ? 'mensalidade'
        : row.commercial_model === 'hybrid'
          ? 'mensalidade + comissao'
          : 'comissao por venda';
      return `Credenciado · ${model}`;
    },

    mapPartnerStockStatus(status) {
      if (status === 'in_stock') return 'ok';
      if (status === 'low_stock') return 'baixo';
      if (status === 'out_of_stock') return 'zerado';
      if (status === 'not_tracked') return 'não controlado';
      return 'validar preço';
    },

    mapPartnerEventType(type) {
      if (type === 'Pagamento funcionario') return 'Pagamento funcionário';
      return type || 'Lançamento';
    },

    funilPct(num, den) {
      const n = Number(num || 0);
      const d = Number(den || 0);
      return d > 0 ? Math.round((n / d) * 100) + '%' : '–';
    },

    applyRede(rows) {
      if (!Array.isArray(rows)) return;
      // API vazia = rede sem parceiros reais → lista vazia (NÃO volta pro mock).
      if (rows.length === 0) { this.parceirosRede = []; return; }

      this.parceirosRede = rows.map((row) => {
        const vendasValor = Number(row.sales_month || 0);
        const pedidos = Number(row.orders_month || 0);
        const comprasPneus = Number(row.purchases_month || 0);
        const folha = Number(row.employee_total || 0);
        const despesasExtras = Number(row.other_expenses_total || 0);
        const custoPendenteItens = Number(row.pending_cost_items_month || 0);
        const custoPendente = custoPendenteItens > 0 || row.has_pending_cost_month === true;
        const lucroEstimado = custoPendente || row.estimated_result_month === null
          || row.estimated_result_month === undefined ? null : Number(row.estimated_result_month);
        const ticket = pedidos > 0 ? vendasValor / pedidos : 0;
        const estoqueRows = Array.isArray(row.stock_rows) ? row.stock_rows : [];
        const events = Array.isArray(row.recent_events) ? row.recent_events : [];
        const topItems = Array.isArray(row.top_items) ? row.top_items : [];
        const serieVendas = Array.isArray(row.sales_series) && row.sales_series.length > 0
          ? row.sales_series.map((value) => Number(value || 0))
          : [0, 0, 0, 0, 0, 0, Number(row.sales_today || 0)];
        const seriePedidos = Array.isArray(row.order_series) && row.order_series.length > 0
          ? row.order_series.map((value) => Number(value || 0))
          : [0, 0, 0, 0, 0, 0, Number(row.orders_today || 0)];
        const margem = vendasValor > 0 && lucroEstimado !== null
          ? Math.round((lucroEstimado / vendasValor) * 100) : null;
        const lastActivityTimes = [
          ...estoqueRows.map((item) => item.updated_at),
          ...events.map((event) => event.event_at),
        ]
          .filter(Boolean)
          .map((value) => new Date(value).getTime())
          .filter((value) => Number.isFinite(value));
        const lastActivityAt = lastActivityTimes.length > 0
          ? new Date(Math.max(...lastActivityTimes)).toISOString()
          : null;
        const diasSemAtualizar = lastActivityAt
          ? Math.max(0, Math.floor((Date.now() - new Date(lastActivityAt).getTime()) / 86400000))
          : null;
        const vendas2w = Number(row.sales_2w || 0);
        const vendasPorta = Number(row.sales_porta || 0);
        const pedidos2w = Number(row.orders_2w || 0);
        const pedidosPorta = Number(row.orders_porta || 0);
        const percentual2w = vendasValor > 0 ? Math.round((vendas2w / vendasValor) * 100) : 0;

        // ─── Cobrança matriz↔parceiro ──────────────────────────────
        // Base da comissão = vendas de origem 2W (o que a matriz trouxe).
        // Mensalidade é valor fixo do mês. O modelo comercial decide o que incide.
        const modeloComercialRaw = row.commercial_model || 'commission';
        const comissaoPercent = row.commission_percent === null || row.commission_percent === undefined
          ? null
          : Number(row.commission_percent);
        const mensalidadeValor = row.monthly_fee === null || row.monthly_fee === undefined
          ? null
          : Number(row.monthly_fee);
        const cobraComissao = modeloComercialRaw === 'commission' || modeloComercialRaw === 'hybrid';
        const cobraMensalidade = modeloComercialRaw === 'monthly' || modeloComercialRaw === 'hybrid';
        const comissaoDevida = cobraComissao && comissaoPercent ? vendas2w * (comissaoPercent / 100) : 0;
        const mensalidadeDevida = cobraMensalidade && mensalidadeValor ? mensalidadeValor : 0;
        const devidoMatriz = comissaoDevida + mensalidadeDevida;

        return {
          id: row.partner_unit_id,
          unitId: row.unit_id,
          partnerId: row.partner_id, // pro settle de comissão + editor de termos (0118)
          slug: row.slug,
          nome: row.display_name || row.partner_name || 'Unidade',
          documento: row.document_number || '-',
          responsavel: row.responsible_name || '-',
          whatsapp: row.whatsapp_phone || '-',
          endereco: row.address || '-',
          modeloComercial: this.partnerCommercialModel(row),
          modeloComercialRaw, // valores crus pro editor de termos (0118)
          comissaoPercentRaw: comissaoPercent,
          mensalidadeRaw: mensalidadeValor,
          comissao: row.commission_percent ? `${Number(row.commission_percent)}%` : (row.monthly_fee ? this.formatCurrency(row.monthly_fee) : '-'),
          cidade: row.address || '-',
          status: this.partnerStatusLabel(row.unit_status || row.partner_status),
          vendas: this.formatCurrency(vendasValor),
          vendasValor,
          pedidos,
          ticketValor: ticket,
          ticket: this.formatCurrency(ticket),
          estoque: `${Number(row.stock_items || 0)} itens`,
          estoqueBaixo: Number(row.low_stock_items || 0),
          // Nota do cliente (0105/0131): média + amostra. null = sem nota ainda
          // (o score de saúde só cobra a nota quando há amostra — não pune quem não tem).
          satisfacaoNota: (row.satisfaction_avg === null || row.satisfaction_avg === undefined)
            ? null : Number(row.satisfaction_avg),
          satisfacaoCount: Number(row.satisfaction_count || 0),
          margem: margem === null ? '-' : `${margem}%`,
          margemValor: margem,
          comprasPneus,
          cogsValor: Number(row.cogs_month || 0),
          folha,
          despesasExtras,
          lucroEstimado,
          custoPendente,
          custoPendenteItens,
          custoPendenteReceita: Number(row.pending_cost_revenue_month || 0),
          vendas2w,
          vendasPorta,
          pedidos2w,
          pedidosPorta,
          percentual2w,
          funilTentou: Number((row.funil && row.funil.tentou) || 0),
          funilPediu: Number((row.funil && row.funil.pediu) || 0),
          funilEfetivou: Number((row.funil && row.funil.efetivou) || 0),
          commercialModel: modeloComercialRaw,
          serviceMode: row.service_mode || 'both',
          fazEntrega: (row.service_mode || 'both') === 'delivery' || (row.service_mode || 'both') === 'both',
          deliveryRadiusKm: (row.delivery_radius_km === null || row.delivery_radius_km === undefined)
            ? null : Number(row.delivery_radius_km),
          comissaoPercent,
          mensalidadeValor,
          comissaoDevida,
          mensalidadeDevida,
          devidoMatriz,
          alerta: custoPendente
            ? `${custoPendenteItens} custo(s) pendente(s)`
            : Number(row.low_stock_items || 0) > 0
            ? `${row.low_stock_items} baixos`
            : Number(row.orders_today || 0) <= 0
              ? 'sem venda hoje'
              : 'ok',
          serieVendas,
          seriePedidos,
          topPneus: topItems.length > 0
            ? topItems.map((item) => ({ pneu: item.label, quantidade: Number(item.quantity || 0) }))
            : [{ pneu: 'sem vendas ainda', quantidade: 0 }],
          estoqueItens: estoqueRows.map((item) => {
            const custo = item.average_cost === null || item.average_cost === undefined ? null : Number(item.average_cost);
            const venda = item.sale_price === null || item.sale_price === undefined ? null : Number(item.sale_price);
            const margemItem = custo !== null && venda !== null && venda > 0
              ? `${Math.round(((venda - custo) / venda) * 100)}%`
              : '-';
            return {
              pneu: item.item_name,
              qtd: item.is_tracked ? item.quantity_on_hand : null,
              minimo: item.minimum_quantity,
              ultimaCompra: item.updated_at ? this.formatDateTime(item.updated_at) : '-',
              fornecedor: item.supplier_name || '-',
              custoMedio: custo === null ? '-' : this.formatCurrency(custo),
              custoValor: custo,
              custo: custo === null ? '-' : this.formatCurrency(custo),
              vendaValor: venda,
              venda: venda === null ? '-' : this.formatCurrency(venda),
              margem: margemItem,
              status: this.mapPartnerStockStatus(item.stock_status),
            };
          }),
          equipe: row.responsible_name ? [row.responsible_name] : [],
          lastActivityAt,
          diasSemAtualizar,
          ultimaAtualizacao: lastActivityAt ? this.formatDateTime(lastActivityAt) : 'sem registro',
          lancamentos: events.map((event) => {
            const tipo = this.mapPartnerEventType(event.type);
            return {
              tipo,
              pendente: typeof tipo === 'string' && tipo.startsWith('Pedido'),
              data: event.event_at ? this.formatDateTime(event.event_at) : '-',
              descricao: event.description || '-',
              valor: Number(event.amount || 0),
            };
          }),
          custosRecentes: [
            { label: 'Compra pneus', value: this.formatCurrency(comprasPneus) },
            { label: 'Folha / funcionários', value: this.formatCurrency(folha) },
            { label: 'Despesas extras', value: this.formatCurrency(despesasExtras) },
          ],
        };
      });

      this.redeKpis = [
        { label: 'Parceiros ativos', value: String(this.parceirosRede.filter((p) => p.status === 'Ativo').length), detail: `${this.parceirosRede.length} cadastrados`, icon: 'building-2', tone: 'bg-emerald-50 text-emerald-700' },
        { label: 'Vendas da rede', value: this.redeTotalVendas(), detail: this.redePeriodLabel(), icon: 'trending-up', tone: 'bg-emerald-50 text-emerald-700' },
        { label: 'Ticket médio', value: this.formatCurrency(this.redeTicketMedio()), detail: `${this.redeTotalPedidos()} pedidos`, icon: 'receipt', tone: 'bg-teal-50 text-teal-700' },
        { label: 'Origem 2W', value: `${this.redeOrigemPercent(this.redeTotal2w())}%`, detail: `${this.formatCurrency(this.redeTotal2w())} da rede`, icon: 'handshake', tone: 'bg-emerald-50 text-emerald-700' },
        { label: 'Estoque total', value: String(this.redeEstoqueQuantidade()), detail: `${this.formatCurrency(this.redeEstoqueValor())} em custo`, icon: 'package', tone: 'bg-amber-50 text-amber-700' },
        { label: 'Alertas operacionais', value: String(this.redeAlertasOperacionais().length), detail: 'risco, estoque ou atualização', icon: 'alert-triangle', tone: 'bg-rose-50 text-rose-700' },
      ];

      if (this.selectedParceiroIndex >= this.parceirosRede.length) {
        this.selectedParceiroIndex = 0;
      }
    },

  };
};
