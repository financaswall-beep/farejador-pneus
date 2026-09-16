window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.financeiroVisaoChart = function () {
  return {
    finVisaoChart() {
      const data = this.finOverview;
      if (!data || data.period !== this.finMes || !data.days.length) return '';
      const cents = v => Math.round(Number(v || 0) * 100);
      let balance = cents(data.opening);
      const actual = data.days.map(day => {
        balance += cents(day.incoming) - cents(day.outgoing);
        return { date: day.date, value: balance / 100 };
      });
      const future = [], current = this.finVisaoAtual(), end = actual.length - 1;
      if (current) {
        const rows = this.finVisaoFluxo().rows;
        future.push({ ...actual[end] });
        for (let day = 0; day <= this.finVisaoDias; day++) {
          for (const row of rows.filter(r => r.dias === day)) balance += (row.direcao === 'entrada' ? 1 : -1) * cents(row.valor);
          const date = new Date(data.through + 'T12:00:00Z');
          date.setUTCDate(date.getUTCDate() + day);
          future.push({ date: date.toISOString().slice(0, 10), value: balance / 100 });
        }
      }
      const width = 760, height = 256, left = 66, right = 24, top = 44, bottom = 32;
      const values = [...actual, ...future].map(p => p.value);
      let low = Math.min(...values), high = Math.max(...values);
      const range = high - low || Math.max(Math.abs(high) * .2, 100);
      const magnitude = Math.pow(10, Math.floor(Math.log10(range / 4)));
      const step = Math.ceil(range / 4 / magnitude) * magnitude;
      low = Math.floor((low - range * .08) / step) * step;
      high = Math.ceil((high + range * .08) / step) * step;
      const totalDays = Math.max(1, end + (current ? this.finVisaoDias : 0));
      const x = day => left + day / totalDays * (width - left - right);
      const y = value => height - bottom - (value - low) / (high - low) * (height - top - bottom);
      const shortMoney = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 }).format(v);
      const money = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 }).format(v);
      const dateLabel = date => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
      const a = actual.map((p, i) => ({ ...p, x: x(i), y: y(p.value) }));
      const f = future.map((p, i) => ({ ...p, x: x(end + Math.max(0, i - 1)), y: y(p.value) }));
      const path = points => points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Saldo de caixa realizado${current ? ' e previsão por vencimentos' : ''}"><defs><linearGradient id="fin-cash-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#069b73" stop-opacity=".16"/><stop offset="1" stop-color="#069b73" stop-opacity="0"/></linearGradient></defs>`;
      if (current) svg += `<rect x="${x(end)}" y="${top}" width="${x(totalDays) - x(end)}" height="${height - top - bottom}" fill="#fff7e9"/>`;
      for (let value = low; value <= high + step / 100; value += step) {
        svg += `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="#e3eaf0"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end" fill="#546681" font-size="11">${shortMoney(value)}</text>`;
      }
      const tickDays = new Set([0, end, totalDays]);
      for (let i = 1; i < totalDays; i++) if (i % Math.max(1, Math.ceil(totalDays / 6)) === 0 && Math.abs(i - end) > 2 && totalDays - i > 2) tickDays.add(i);
      for (const day of [...tickDays].sort((a, b) => a - b)) {
        const d = new Date(data.days[0].date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + day);
        svg += `<line x1="${x(day)}" x2="${x(day)}" y1="${top}" y2="${height - bottom}" stroke="#e3eaf0"/><text x="${x(day)}" y="${height - 9}" text-anchor="middle" fill="#546681" font-size="11">${dateLabel(d.toISOString().slice(0, 10))}</text>`;
      }
      svg += `<path d="${path(a)} L${a[end].x},${height - bottom} L${a[0].x},${height - bottom} Z" fill="url(#fin-cash-fill)"/><path d="${path(a)}" fill="none" stroke="#007451" stroke-width="3" stroke-linejoin="round"/>`;
      if (f.length) svg += `<path d="${path(f)}" fill="none" stroke="#07976f" stroke-width="2.5" stroke-dasharray="6 5"/><line x1="${x(end)}" x2="${x(end)}" y1="${top - 7}" y2="${height - bottom}" stroke="#62b59f" stroke-dasharray="3 3"/><text x="${x(end)}" y="29" text-anchor="middle" fill="#546681" font-size="11">Hoje</text><text x="${width - right}" y="18" text-anchor="end" fill="#a15b00" font-size="10" font-weight="600">PREVISÃO · ${this.finVisaoDias} DIAS</text>`;
      for (const [i, point] of [...a, ...f].entries()) {
        const featured = i === 0 || i === end || i === a.length + f.length - 1;
        svg += `<circle cx="${point.x}" cy="${point.y}" r="${featured ? 5 : 3}" fill="#007451" stroke="white" stroke-width="1"><title>${dateLabel(point.date)}: ${money(point.value)}${i >= a.length ? ' (previsto)' : ''}</title></circle>`;
        if (featured) svg += `<text x="${point.x}" y="${Math.max(top - 2, point.y - 12)}" text-anchor="${i === 0 ? 'start' : i === a.length + f.length - 1 ? 'end' : 'middle'}" font-size="12" font-weight="700" fill="#10243e">${money(point.value)}</text>`;
      }
      return svg + '</svg>';
    },
  };
};
