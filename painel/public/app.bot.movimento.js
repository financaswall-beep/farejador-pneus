// Movimento diário/semanal do Bot. Todos os cards e o gráfico consomem o mesmo
// payload e, portanto, o mesmo recorte de datas e a mesma fonte auditada.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botMovimento = function () {
  const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const WEEKDAYS_LONG = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  function utcDate(value) {
    const [year, month, day] = String(value || '').split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  function weekStart(value) {
    const parsed = utcDate(value);
    return window.FarejadorTime.addDays(value, -parsed.getUTCDay());
  }

  function shortMonth(value) {
    return new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(utcDate(value));
  }

  return {
    botMovement: null,
    botMovementMode: 'daily',
    botMovementDate: '',
    botMovementLoading: false,
    botMovementError: null,
    botMovementRequestId: 0,
    async loadBotMovement() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      if (!this.botMovementDate) this.botMovementDate = window.FarejadorTime.businessDate(new Date());
      const requestId = ++this.botMovementRequestId;
      this.botMovementLoading = true;
      this.botMovementError = null;
      try {
        const query = new URLSearchParams({
          mode: this.botMovementMode,
          date: this.botMovementDate,
        });
        const payload = await this.apiGet('/admin/api/bot/movimento?' + query.toString());
        if (requestId !== this.botMovementRequestId) return;
        this.botMovement = payload;
        this.botMovementDate = payload.range.selected_date;
      } catch (err) {
        if (requestId !== this.botMovementRequestId) return;
        this.botMovementError = 'Não consegui carregar o movimento (' + err.message + ').';
      } finally {
        if (requestId === this.botMovementRequestId) this.botMovementLoading = false;
      }
      this.$nextTick(() => lucide.createIcons());
    },

    selectBotMovementDay(date) {
      if (!date || date > this.botMovementToday) return;
      this.botMovementMode = 'daily';
      this.botMovementDate = date;
      void this.loadBotMovement();
    },

    setBotMovementMode(mode) {
      if (!['daily', 'weekly'].includes(mode) || this.botMovementMode === mode) return;
      this.botMovementMode = mode;
      void this.loadBotMovement();
    },

    moveBotMovementWeek(direction) {
      const candidate = window.FarejadorTime.addDays(this.botMovementDate || this.botMovementToday, direction * 7);
      this.botMovementDate = candidate > this.botMovementToday ? this.botMovementToday : candidate;
      void this.loadBotMovement();
    },

    get botMovementToday() {
      return (this.botMovement && this.botMovement.range && this.botMovement.range.today)
        || window.FarejadorTime.businessDate(new Date());
    },
    get botMovementCards() {
      return (this.botMovement && this.botMovement.cards) || null;
    },
    get botMovementComparison() {
      return (this.botMovement && this.botMovement.comparison) || {};
    },
    get botMovementWeekDays() {
      const selected = this.botMovementDate || this.botMovementToday;
      const start = weekStart(selected);
      return Array.from({ length: 7 }, (_, index) => {
        const date = window.FarejadorTime.addDays(start, index);
        return {
          date,
          label: WEEKDAYS[index],
          day: Number(date.slice(-2)),
          today: date === this.botMovementToday,
          selected: date === selected,
          future: date > this.botMovementToday,
        };
      });
    },
    get botMovementCanNextWeek() {
      const selected = this.botMovementDate || this.botMovementToday;
      return window.FarejadorTime.addDays(weekStart(selected), 6) < this.botMovementToday;
    },
    get botMovementWeekLabel() {
      const days = this.botMovementWeekDays;
      if (!days.length) return '—';
      const first = days[0].date;
      const last = days[6].date;
      const firstMonth = shortMonth(first);
      const lastMonth = shortMonth(last);
      return firstMonth === lastMonth
        ? `${days[0].day} a ${days[6].day} de ${lastMonth}`
        : `${days[0].day} de ${firstMonth} a ${days[6].day} de ${lastMonth}`;
    },
    get botMovementScopeLabel() {
      if (this.botMovementMode === 'weekly') return this.botMovementWeekLabel;
      return window.FarejadorTime.formatDate(this.botMovementDate || this.botMovementToday);
    },
    get botMovementTitle() {
      if (this.botMovementMode === 'weekly') return 'Movimento da semana';
      const date = this.botMovementDate || this.botMovementToday;
      return `Movimento de ${WEEKDAYS_LONG[utcDate(date).getUTCDay()]}, ${Number(date.slice(-2))}`;
    },
    get botMovementSubtitle() {
      return this.botMovementMode === 'weekly'
        ? 'Conversas iniciadas por horário na semana selecionada'
        : 'Conversas iniciadas por horário no dia selecionado';
    },
    get botMovementComparisonLabel() {
      return this.botMovementMode === 'weekly' ? 'vs. semana anterior' : 'vs. dia anterior';
    },
    get botMovementHorarios() {
      const data = (this.botMovement && this.botMovement.horarios) || [];
      const byHour = Object.fromEntries(data.map((item) => [Number(item.hora), Number(item.conversas || 0)]));
      const rows = Array.from({ length: 24 }, (_, hour) => ({
        hora: hour,
        label: String(hour).padStart(2, '0') + 'h',
        n: byHour[hour] || 0,
        showLabel: hour % 3 === 0 || hour === 23,
      }));
      const max = Math.max(0, ...rows.map((item) => item.n));
      return rows.map((item) => ({
        ...item,
        pct: max > 0 ? Math.round((item.n / max) * 100) : 0,
        peak: max > 0 && item.n === max,
      }));
    },
    get botMovementHourlyMax() {
      return Math.max(0, ...this.botMovementHorarios.map((item) => item.n));
    },
    get botMovementPeak() {
      const peak = this.botMovementHorarios.find((item) => item.peak);
      return peak ? peak.label : '—';
    },
    botMovementDeltaText(value, suffix = '%') {
      if (value == null) return 'sem base anterior';
      const number = Number(value || 0);
      return `${number > 0 ? '+' : ''}${number}${suffix}`;
    },
    botMovementDeltaClass(value) {
      if (value == null || Number(value) === 0) return 'bg-gray-100 text-gray-600';
      return Number(value) > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700';
    },
  };
};
