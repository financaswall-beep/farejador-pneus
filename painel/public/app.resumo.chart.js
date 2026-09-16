window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.resumoChart=function(){return {
  renderOverviewChart() {
    if (this.currentPage!=='resumo'||!this.isMatrixPanel()||!this.overview) return;
    const canvas=document.getElementById('chartOverviewSales');
    if(!canvas||!window.Chart)return;
    const days=[], period=this.overview.period;
    for(let date=new Date(period.from+'T12:00:00Z');date.toISOString().slice(0,10)<=period.to;date.setUTCDate(date.getUTCDate()+1)) days.push(date.toISOString().slice(0,10));
    const rows=new Map(this.overview.sales.daily.map(row=>[`${row.day}:${row.channel}`,row.revenue/100]));
    window._overviewChart?.destroy();
    window._overviewChart=new Chart(canvas,{type:'line',data:{labels:days.map(date=>this.overviewDate(date)),datasets:[
      {label:'Varejo',data:days.map(day=>rows.get(`${day}:varejo`)||0),borderColor:'#007f60',backgroundColor:'rgba(0,127,96,.07)',fill:true},
      {label:'Atacado',data:days.map(day=>rows.get(`${day}:atacado`)||0),borderColor:'#35b8bc',backgroundColor:'transparent',fill:false},
    ].map(row=>({...row,borderWidth:2.5,tension:0,pointRadius:days.length===1?5:2,pointHoverRadius:5}))},options:{
      responsive:true,maintainAspectRatio:false,animation:false,interaction:{intersect:false,mode:'index'},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:context=>`${context.dataset.label}: ${this.overviewMoney(context.parsed.y*100)}`}}},
      scales:{x:{grid:{display:false},ticks:{color:'#6b7d8b',maxTicksLimit:7,maxRotation:0},border:{display:false}},
        y:{beginAtZero:true,ticks:{color:'#6b7d8b',maxTicksLimit:5,callback:value=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0,notation:'compact'}).format(value)},grid:{color:'#edf2f3'},border:{display:false}}},
    }});
  },
};};
