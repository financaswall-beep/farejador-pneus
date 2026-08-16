(function () {
  'use strict';

  const Caixa = window.Caixa;
  const elements = Caixa.elements;

  function weeklyDate(value) {
    return new Date(String(value) + 'T12:00:00-03:00');
  }

  function weeklyRangeLabel(series) {
    if (!series.length) return 'Semana atual';
    const first = weeklyDate(series[0].date);
    const last = weeklyDate(series[series.length - 1].date);
    const month = new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(last).replace('.', '');
    return String(first.getDate()).padStart(2, '0') + '–'
      + String(last.getDate()).padStart(2, '0') + ' ' + month;
  }

  function niceAxisStep(value) {
    const safe = Math.max(1, Number(value || 0));
    const power = Math.pow(10, Math.floor(Math.log10(safe)));
    const normalized = safe / power;
    const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return factor * power;
  }

  function axisLabel(value) {
    return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value);
  }

  function localDateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date).reduce(function (result, part) {
      result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function selectedDay(payload) {
    const series = Array.isArray(payload.daily_series) ? payload.daily_series : [];
    return series.find(function (day) { return day.date === Caixa.state.selectedSalesDay; }) || null;
  }

  function readableDay(value) {
    return new Intl.DateTimeFormat('pt-BR', { weekday: 'long' }).format(weeklyDate(value));
  }

  function selectionSales(payload) {
    const sales = Array.isArray(payload.sales) ? payload.sales : [];
    if (!Caixa.state.selectedSalesDay) return sales;
    return sales.filter(function (sale) {
      return localDateKey(sale.created_at) === Caixa.state.selectedSalesDay;
    });
  }

  function renderSelectionCopy(payload) {
    const day = selectedDay(payload);
    const label = day ? readableDay(day.date) : '';
    elements.weeklyTotalLabel.textContent = day ? `Faturamento de ${label}` : 'Faturamento da semana';
    elements.weeklySummaryTitle.textContent = day ? `Resumo de ${label}` : 'Resumo semanal';
    elements.salesListTitle.textContent = day ? `Vendas de ${label}` : 'Minhas vendas recentes';
    elements.weeklyClearDay.classList.toggle('hidden', !day);
  }

  function renderWeeklySummary(payload) {
    const summary = payload.summary || {};
    const series = Array.isArray(payload.daily_series) ? payload.daily_series : [];
    const values = series.map(function (day) { return Number(day.revenue || 0); });
    const max = Math.max(1, ...values);
    const axisStep = niceAxisStep(max / 3);
    const axisMax = axisStep * 3;
    const average = series.length ? Number(summary.revenue || 0) / series.length : 0;
    const offset = Number(payload.week_offset || 0);
    const activeSummary = selectedDay(payload) || summary;
    elements.weeklySummary.classList.remove('hidden');
    elements.weeklyRange.textContent = weeklyRangeLabel(series);
    elements.weeklyWeekState.textContent = offset === 0 ? 'Semana atual'
      : (offset === -1 ? 'Semana anterior' : Math.abs(offset) + ' semanas atrás');
    elements.weeklyPrev.disabled = offset <= -52;
    elements.weeklyNext.disabled = offset >= 0;
    elements.weeklyTotal.textContent = Caixa.currency.format(Number(activeSummary.revenue || 0));
    elements.weeklySalesCount.textContent = String(activeSummary.sales_count || 0);
    elements.weeklyItemsCount.textContent = String(activeSummary.items_quantity || 0);
    elements.weeklyTicket.textContent = Caixa.currency.format(Number(activeSummary.average_ticket || 0));
    elements.weeklyCommission.textContent = Caixa.currency.format(Number(activeSummary.commission_amount || 0));
    renderSelectionCopy(payload);
    elements.weeklyReference.style.bottom = Math.min(94, average / axisMax * 100) + '%';
    elements.weeklyReferenceValue.textContent = 'média ' + Caixa.currency.format(average);
    elements.weeklyGrid.replaceChildren();
    [3, 2, 1, 0].forEach(function (level) {
      const line = document.createElement('span');
      line.style.bottom = (level / 3 * 100) + '%';
      const label = document.createElement('b');
      label.textContent = axisLabel(axisStep * level);
      line.appendChild(label);
      elements.weeklyGrid.appendChild(line);
    });
    elements.weeklyBars.replaceChildren();
    const weekdayFormat = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
    series.forEach(function (day) {
      const date = weeklyDate(day.date);
      const item = document.createElement('button');
      item.type = 'button';
      const isSelected = Caixa.state.selectedSalesDay === day.date;
      item.className = 'weekly-bar-item' + (Number(day.revenue || 0) === max ? ' is-best' : '')
        + (isSelected ? ' is-selected' : '');
      item.dataset.salesDay = day.date;
      item.setAttribute('aria-pressed', String(isSelected));
      item.setAttribute('aria-label', `${readableDay(day.date)}: ${Caixa.currency.format(Number(day.revenue || 0))}. Filtrar por este dia.`);
      const value = document.createElement('span');
      value.className = 'weekly-bar-value';
      value.textContent = Number(day.revenue || 0) ? Number(day.revenue).toFixed(2).replace('.', ',') : '0';
      const bar = document.createElement('i');
      const ratio = Math.max(0.03, Number(day.revenue || 0) / axisMax);
      bar.style.height = (ratio * 100) + '%';
      value.style.bottom = Math.min(160, 38 + ratio * 136) + 'px';
      const weekday = document.createElement('small');
      weekday.textContent = weekdayFormat.format(date).replace('.', '');
      const dayNumber = document.createElement('b');
      dayNumber.textContent = String(date.getDate()).padStart(2, '0');
      item.append(value, bar, weekday, dayNumber);
      elements.weeklyBars.appendChild(item);
    });
  }

  Object.assign(Caixa, {
    selectedSalesDay: selectedDay,
    selectedSales: selectionSales,
    renderWeeklySummary: renderWeeklySummary,
  });
}());
