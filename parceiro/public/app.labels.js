/**
 * app.labels.js - fabrica `labels` do painel do parceiro (obra <=300, passo 2/11).
 * MORA AQUI: rotulos e avisos PUROS (so leitura) - categoria de despesa/conta,
 * origem da venda (2W/porta), chips de status do estoque, posicao/origem do pneu,
 * rotulos de quantidade 0076 (display), toast (flash/inferStatusKind) e errMessage.
 * NAO MORA AQUI: stockAvailable/stockItemValue e acoes de estoque (contrato 0076,
 * passo 7). VEIO DE: app.js commit 7f6e7ee, 4 sub-blocos VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.labels = () => ({
    categoryLabel(category) {
      const map = {
        employee_payment: 'Funcionário',
        rent: 'Aluguel',
        utilities: 'Contas',
        maintenance: 'Manutenção',
        delivery: 'Entrega',
        tax: 'Taxa/imposto',
        supplier_payment: 'Fornecedor',
        other: 'Outra',
      };
      return map[category] || category || 'Despesa';
    },

    payableCategoryLabel(category) {
      const map = {
        supplier: 'Fornecedor',
        employee: 'Funcionário',
        rent: 'Aluguel',
        utilities: 'Contas',
        tax: 'Taxa/imposto',
        maintenance: 'Manutenção',
        other: 'Outra',
      };
      return map[category] || category || 'Conta';
    },

    normalizeSource(source) {
      const value = String(source || '').trim().toLowerCase();
      if (value === '2w') return '2w';
      if (value === 'walkin_balcao' || value === 'walkin_telefone' || value === 'porta') return 'porta';
      return value || 'porta';
    },

    sourceLabel(source) {
      const map = {
        '2w': '2W',
        porta: 'Porta',
        walkin_balcao: 'Porta',
        walkin_telefone: 'Telefone',
        outro: 'Outro',
      };
      return map[source] || map[this.normalizeSource(source)] || 'Porta';
    },

    sourceClass(source) {
      const normalized = this.normalizeSource(source);
      if (normalized === '2w') return 'bg-emerald-50 text-emerald-700';
      if (normalized === 'porta') return 'bg-gray-100 text-gray-700';
      return 'bg-blue-50 text-blue-700';
    },

    stockStatusClass(status) {
      const map = {
        in_stock: 'bg-emerald-50 text-emerald-700',
        low_stock: 'bg-amber-50 text-amber-700',
        reserved: 'bg-indigo-50 text-indigo-700',
        out_of_stock: 'bg-rose-50 text-rose-700',
        not_tracked: 'bg-gray-100 text-gray-600',
        unknown: 'bg-gray-100 text-gray-500',
      };
      return map[status] || 'bg-gray-100 text-gray-600';
    },

    stockStatusLabel(status) {
      const map = {
        in_stock: 'Em estoque',
        low_stock: 'Estoque baixo',
        reserved: 'Reservado',
        out_of_stock: 'Zerado',
        not_tracked: 'Não controlado',
        unknown: 'Sem mínimo',
      };
      return map[status] || 'Sem status';
    },

    // Frente de caixa e dropdown de venda mostram o que pode ser vendido agora.
    // Se houver reserva aberta, explicita o físico para o usuário entender a diferença.
    stockAvailabilityLabel(item) {
      if (!item || !item.is_tracked) return 'sem controle';
      const available = this.stockAvailable(item);
      const reserved = this.num(item.quantity_reserved);
      if (reserved > 0) return `${available} disp. (${this.num(item.quantity_on_hand)} fis.)`;
      return `${available} un.`;
    },

    stockPositionValue(value) {
      const raw = String(value || '').trim().toLowerCase();
      if (raw.includes('traseiro')) return 'Traseiro';
      if (raw.includes('dianteiro')) return 'Dianteiro';
      return '';
    },

    stockPositionLabel(item) {
      // Coluna própria (migration 0075) tem prioridade.
      const fromColumn = this.stockPositionValue(item?.tire_position);
      if (fromColumn) return fromColumn;
      // Fallback p/ linhas legadas ainda não re-salvas.
      const fromSupplier = this.stockPositionValue(item?.supplier_name);
      if (fromSupplier) return fromSupplier;
      const fromName = this.stockPositionValue(item?.item_name);
      return fromName || '-';
    },

    stockOriginKey(item) {
      const supplier = String(item?.supplier_name || '').toLowerCase();
      return supplier.includes('2w') ? '2w' : 'porta';
    },

    stockOriginLabel(item) {
      return this.stockOriginKey(item) === '2w' ? '2W' : 'Porta';
    },

    // 0076: rótulo de quantidade na tabela. Mostra físico; quando há reserva aberta,
    // anexa o disponível ("físico (N disp.)") para deixar claro o que está comprometido.
    stockQtyDisplay(item) {
      if (!item || !item.is_tracked) return '-';
      const physical = this.num(item.quantity_on_hand);
      const reserved = this.num(item.quantity_reserved);
      if (reserved > 0) return `${physical} (${this.stockAvailable(item)} disp.)`;
      return physical;
    },

    errMessage(err) {
      const raw = err instanceof Error ? err.message : String(err);
      const map = {
        customer_phone_conflict: 'Já existe um cliente com esse telefone.',
        customer_cpf_conflict: 'Já existe um cliente com esse CPF.',
        customer_not_found: 'Cliente não encontrado.',
        customer_name_required: 'Informe o nome do cliente.',
        installments_not_supported: 'Venda parcelada nao e suportada.',
      };
      return map[raw] || raw;
    },

    flash(msg, kind) {
      // kind: 'success' | 'error' | 'neutral'. Heurística automática se omitido.
      this.statusMessage = msg;
      this.statusKind = kind || this.inferStatusKind(msg);
      if (this.statusTimer) clearTimeout(this.statusTimer);
      this.statusTimer = setTimeout(() => { this.statusMessage = ''; }, 3500);
    },

    inferStatusKind(msg) {
      const text = String(msg || '').toLowerCase();
      if (text.includes('insuficiente') || text.includes('erro') || text.includes('inválido')
          || text.includes('invalida') || text.includes('falha') || text.includes('not found')
          || text.includes('inativ') || text.includes('preencha') || text.includes('selecione')) {
        return 'error';
      }
      if (text.includes('registrada') || text.includes('salv') || text.includes('cancelad')
          || text.includes('atualiz') || text.includes('excluí')) {
        return 'success';
      }
      return 'neutral';
    },
});
