window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerRetiradasReport = function () {
  const zone = { timeZone: 'America/Sao_Paulo' };
  const day = new Intl.DateTimeFormat('en-CA', zone);
  const time = new Intl.DateTimeFormat('pt-BR', { ...zone, hour: '2-digit', minute: '2-digit' });
  const date = new Intl.DateTimeFormat('pt-BR', { ...zone, day: '2-digit', month: '2-digit' });
  const normalizeSearch = (value) => String(value ?? '').normalize('NFD')
    .replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
  const when = (value) => value ? new Date(value).getTime() : NaN;
  return {
    partnerRetiradasStage(row) {
      if (row?.retrieved_at || (row?.status === 'paid' && row?.awaiting_pickup === false)) return 'completed';
      if (row?.pickup_installation_started_at) return 'installing';
      if (row?.pickup_arrived_at) return 'arrived';
      if (row?.pickup_ready_at) return 'ready';
      return 'waiting';
    },
    partnerRetiradasStageLabel(row) {
      return ({ waiting: 'A separar', ready: 'Pronto para retirar', arrived: 'Na loja',
        installing: 'Em instalação', completed: 'Concluída' })[this.partnerRetiradasStage(row)];
    },
    partnerRetiradasStageClass(row) {
      return ({ waiting: 'bg-gray-100 text-gray-700', ready: 'bg-emerald-100 text-emerald-900',
        arrived: 'bg-emerald-50 text-emerald-900', installing: 'bg-teal-50 text-teal-900',
        completed: 'bg-gray-100 text-gray-700' })[this.partnerRetiradasStage(row)];
    },
    partnerRetiradasStepReached(row, step) {
      const reached = ({ waiting: 0, ready: 0, arrived: 1, installing: 3, completed: 4 })[
        this.partnerRetiradasStage(row)
      ] ?? 0;
      const target = ({ arrived: 1, payment: 2, installing: 3, completed: 4 })[step] ?? 99;
      return reached >= target;
    },
    partnerRetiradasIsToday(value) {
      const instant = when(value);
      return Number.isFinite(instant) && day.format(instant) === day.format(Date.now());
    },
    partnerRetiradasCode(row) {
      return row?.order_public_code || row?.public_code || (row?.order_number != null ? String(row.order_number)
        : `#${String(row?.order_id || '').slice(0, 8).toUpperCase()}`);
    },
    partnerRetiradasExpiry(row) {
      if (!['waiting', 'ready'].includes(this.partnerRetiradasStage(row))) return '';
      const remainder = when(row?.reservation_expires_at) - Date.now();
      if (remainder <= 0) return 'expired';
      if (remainder <= 60 * 60_000) return 'soon';
      return '';
    },
    partnerRetiradasExpiryLabel(row) {
      const instant = when(row?.reservation_expires_at);
      if (!Number.isFinite(instant)) return '—';
      const now = Date.now();
      const label = day.format(instant) === day.format(now) ? 'Hoje'
        : day.format(instant) === day.format(now + 86_400_000) ? 'Amanhã' : date.format(instant);
      return `${label}, ${time.format(instant)}`;
    },
    partnerRetiradasExpiryClass(row) {
      return ({ soon: 'bg-amber-100 text-amber-900', expired: 'bg-rose-50 text-rose-800' })[
        this.partnerRetiradasExpiry(row)
      ] || 'text-gray-600';
    },
    partnerRetiradasHistory(row) {
      return [
        [row.reservation_started_at ? 'Reserva criada' : 'Pedido criado', row.reservation_started_at || row.created_at],
        ['Marcado como pronto', row.pickup_ready_at],
        ['Cliente chegou', row.pickup_arrived_at],
        ['Instalação iniciada', row.pickup_installation_started_at],
        ['Retirada concluída', row.retrieved_at],
      ].filter(([, value]) => Number.isFinite(when(value))).sort((a, b) => when(a[1]) - when(b[1]));
    },
    get partnerRetiradasSummary() {
      const rows = this.partnerRetiradasPeriodRows;
      return {
        open: rows.filter((row) => this.partnerRetiradasStage(row) !== 'completed').length,
        ready: rows.filter((row) => this.partnerRetiradasStage(row) === 'ready'
          && this.partnerRetiradasExpiry(row) !== 'expired').length,
        soon: rows.filter((row) => this.partnerRetiradasExpiry(row) === 'soon').length,
        // "Chegaram hoje" continua contando quem ja avancou para instalacao ou conclusao.
        arrived: rows.filter((row) => this.partnerRetiradasIsToday(row.pickup_arrived_at)).length,
        installing: rows.filter((row) => this.partnerRetiradasStage(row) === 'installing').length,
        completed: rows.filter((row) => this.partnerRetiradasStage(row) === 'completed'
          && this.partnerRetiradasIsToday(row.retrieved_at)).length,
      };
    },
    get partnerRetiradasPeriodRows() {
      if (this.partnerRetiradasPeriod !== 'today') return this.partnerRetiradasRows;
      return this.partnerRetiradasRows.filter((row) => this.partnerRetiradasIsToday(
        row.retrieved_at || row.pickup_arrived_at || row.reservation_expires_at || row.created_at,
      ));
    },
    get partnerRetiradasFilteredRows() {
      const query = normalizeSearch(this.partnerRetiradasSearch);
      return this.partnerRetiradasPeriodRows.filter((row) => {
        const stage = this.partnerRetiradasStage(row);
        const matchesStage = this.partnerRetiradasFilter === 'all'
          || this.partnerRetiradasFilter === stage
          || (this.partnerRetiradasFilter === 'arrived' && stage === 'installing');
        const haystack = normalizeSearch([row.customer_name, row.order_id, row.order_number,
          this.partnerRetiradasCode(row), this.partnerRetiradasItemsLabel(row)].join(' '));
        return matchesStage && (!query || haystack.includes(query));
      });
    },
    partnerRetiradasWaLink(row) {
      if (this.partnerRetiradasStage(row) !== 'ready' || this.partnerRetiradasExpiry(row) === 'expired') return '';
      let digits = this.partnerRetiradasPhone(row);
      if ([10, 11].includes(digits.length)) digits = `55${digits}`;
      if (!/^\d{12,15}$/.test(digits)) return '';
      const startsAt = when(row.fulfillment_not_before);
      const schedule = startsAt > Date.now() ? ` A retirada começa em ${date.format(startsAt)}, às ${time.format(startsAt)}.` : '';
      return `https://wa.me/${digits}?text=${encodeURIComponent('Olá! Seu pedido está pronto para retirada na loja.' + schedule)}`;
    },
    partnerRetiradasNotify(row, event) {
      const href = this.partnerRetiradasWaLink(row);
      if (href) { event.currentTarget.href = href; return; }
      event.preventDefault();
      this.partnerRetiradasError = 'Este pedido já mudou. Atualize a fila antes de avisar o cliente.';
    },
  };
};
