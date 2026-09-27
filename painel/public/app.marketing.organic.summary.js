// Resumo comercial: somente origem confirmada; dados ausentes nunca viram zero.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingOrganicSummary = function () {
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  let chart = null;
  return {
    moSummaryPeriod: '7d',
    moSummaryWindow() {
      const supplied = this.moDetail?.attribution?.period;
      if (supplied?.id === this.moSummaryPeriod) return supplied;
      if (!this.moSelected?.published_at) return null;
      const since = new Intl.DateTimeFormat('sv-SE', {timeZone:'America/Sao_Paulo'}).format(new Date(this.moSelected.published_at));
      const end = new Date(since + 'T12:00:00Z');
      end.setUTCDate(end.getUTCDate() + (this.moSummaryPeriod === '30d' ? 29 : 6));
      return {id:this.moSummaryPeriod, since, until:end.toISOString().slice(0,10)};
    },
    moSummaryRange() {
      const period = this.moSummaryWindow();
      if (!period) return '—';
      const date = value => new Date(value+'T12:00:00Z').toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric',timeZone:'America/Sao_Paulo'}).replace(/ de /g,' ');
      return (period.since.slice(0,7) === period.until.slice(0,7) ? period.since.slice(8) : date(period.since)) + ' a ' + date(period.until);
    },
    moSummaryReady() {
      const data = this.moDetail?.attribution;
      return data?.status === 'ready' && data.period?.id === this.moSummaryPeriod;
    },
    moSummaryValue(key) { return this.moSummaryReady() ? number(this.moDetail.attribution[key]) : null; },
    moSummaryCards() {
      return [
        {key:'private_messages', label:'Privadas enviadas', icon:'send'},
        {key:'conversations', label:'Conversas iniciadas', icon:'message-square'},
        {key:'sales', label:'Vendas concluídas', icon:'shopping-cart', featured:true},
        {key:'revenue', label:'Valor vendido', icon:'coins', money:true},
      ].map(card => ({...card,value:this.moSummaryValue(card.key)}));
    },
    moSummaryNumber(value, money = false) {
      if (number(value) == null) return '—';
      return value.toLocaleString('pt-BR', money ? {style:'currency',currency:'BRL'} : {maximumFractionDigits:0});
    },
    moConversion() {
      const conversations = this.moSummaryValue('conversations'), converted = this.moSummaryValue('converted_conversations');
      return conversations > 0 && converted != null && converted <= conversations ? converted / conversations * 100 : null;
    },
    moConversionText() {
      if (this.moConversion() == null) return 'Conversão ainda sem dados confirmados';
      return this.moSummaryNumber(this.moSummaryValue('converted_conversations')) + ' de ' + this.moSummaryNumber(this.moSummaryValue('conversations')) + ' conversas viraram venda';
    },
    moConversionPercent() {
      const value = this.moConversion();
      return value == null ? '—' : value.toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1}) + '%';
    },
    moPostContext() {
      const post = this.moSelected;
      if (!post) return '';
      const measure = (post.title + ' ' + post.caption).match(/\b\d{2,3}\/\d{2,3}\s*[-R]\s*\d{2}\b/i)?.[0];
      return (measure || this.moFormat(post.format)) + ' · ' + this.moNetworkLabel(post.platform);
    },
    moChangeSummaryPeriod() {
      if (this.moAnalysisTab==='compare') return this.moLoadCompare();
      if (this.moSelected) return this.moOpen(this.moSelected, true);
    },
    moSalesSeries() {
      const data = this.moDetail?.attribution;
      if (!this.moSummaryReady() || !Array.isArray(data.sales_series)) return [];
      const period = this.moSummaryWindow();
      // The server supplies a complete cumulative series; never interpolate missing sales.
      if (!data.sales_series.every(row => row && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
        && row.date >= period.since && row.date <= period.until && number(row.sales) != null && Number.isInteger(row.sales))) return [];
      const rows = data.sales_series.map(row => ({date:row.date,sales:row.sales})).sort((a,b) => a.date.localeCompare(b.date));
      return rows.every((row,i) => !i || row.date > rows[i-1].date && row.sales >= rows[i-1].sales) ? rows : [];
    },
    moDestroyChart() { if (chart) { chart.destroy(); chart = null; } },
    moRenderChart() {
      this.moDestroyChart();
      const canvas = this.$refs.moSalesChart, rows = this.moSalesSeries();
      if (this.moAnalysisTab==='compare' || !this.moSelected || this.moDetailLoading || !canvas || !rows.length || typeof Chart === 'undefined') return;
      const labels = rows.map(row => new Date(row.date+'T12:00:00Z').toLocaleDateString('pt-BR',{day:'2-digit',month:'short',timeZone:'America/Sao_Paulo'}));
      chart = new Chart(canvas, {
        type:'line', data:{labels,datasets:[{label:'Vendas concluídas acumuladas',data:rows.map(row => row.sales),
          borderColor:'#00876f',borderWidth:2.5,pointRadius:5,pointHoverRadius:7,pointBackgroundColor:'#00876f',
          pointBorderColor:'#fff',pointBorderWidth:1.5,tension:0,fill:true,
          backgroundColor:context => { const area=context.chart.chartArea; if(!area)return '#e8f7f1';
            const gradient=context.chart.ctx.createLinearGradient(0,area.top,0,area.bottom);gradient.addColorStop(0,'#bcebdc99');gradient.addColorStop(1,'#e6f7f16b');return gradient; }
        }]},
        plugins:[{id:'organicValues',afterDatasetsDraw(chart) {
          if(rows.length>10)return;
          const ctx=chart.ctx;ctx.save();ctx.fillStyle='#00836b';ctx.font='600 13px Arial';ctx.textAlign='center';
          chart.getDatasetMeta(0).data.forEach((point,i)=>ctx.fillText(String(rows[i].sales),point.x,point.y-15));ctx.restore();
        }}],
        options:{responsive:true,maintainAspectRatio:false,animation:false,layout:{padding:{top:28,right:13,left:5}},
          interaction:{intersect:false,mode:'index'},plugins:{legend:{display:false},tooltip:{callbacks:{label:item=>item.parsed.y+' vendas concluídas acumuladas'}}},
          scales:{x:{grid:{color:'#e9eef4'},ticks:{color:'#40547b',maxRotation:0,maxTicksLimit:7,font:{size:12}}},
            y:{beginAtZero:true,grid:{color:'#e9eef4'},ticks:{color:'#40547b',precision:0,maxTicksLimit:5,font:{size:12}}}}}
      });
    },
    moSummaryExportRows() {
      const post=this.moSelected, period=this.moSummaryWindow();
      if (!post || !this.moDetail || !period) return [];
      return [['Publicação',post.title],['Rede',this.moNetworkLabel(post.platform)],['ID',post.id],['Publicado em',post.published_at],
        ['Janela',this.moSummaryPeriod==='7d'?'Primeiros 7 dias do post':'Primeiros 30 dias do post'],['Início',period.since],['Fim',period.until],
        ['Origem',this.moSummaryReady()?'Confirmada':'Vínculo pendente'],['Dados',this.marketingIsMock()?'Ilustrativos':'Reais'],
        ...this.moSummaryCards().map(card=>[card.label,card.value == null?'Indisponível':this.moSummaryNumber(card.value,card.money)]),
        ['Conversão de conversas',this.moConversion() == null?'Indisponível':this.moConversionPercent()],
        ['Observação','Somente vendas concluídas com origem confirmada. Valor vendido não representa lucro.'],
        [],['Data','Vendas concluídas acumuladas'],...this.moSalesSeries().map(row=>[row.date,row.sales])];
    },
    moSummaryCsv(rows = this.moSummaryExportRows()) {
      const cell = value => { let text=String(value ?? '');if(/^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"'; };
      return '\uFEFF'+rows.map(row=>row.map(cell).join(';')).join('\r\n');
    },
    moExportSummary() {
      if (!this.moDetail || this.moDetailLoading) return;
      this.moDownloadCsv(this.moSummaryExportRows(),'publicacao-'+this.moSelected.platform+'-'+this.moSelected.id+'-'+this.moSummaryPeriod+'.csv');
    },
    moDownloadCsv(rows, filename) {
      const url=URL.createObjectURL(new Blob([this.moSummaryCsv(rows)],{type:'text/csv;charset=utf-8'}));
      const link=document.createElement('a');link.href=url;link.download=filename;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    },
  };
};
