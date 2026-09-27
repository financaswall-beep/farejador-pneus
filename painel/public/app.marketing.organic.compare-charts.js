// Instâncias de Chart fora do estado reativo do Alpine.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingOrganicCompareCharts = function () {
  let charts=[];
  const colors=['#00866e','#123f77'];
  const values={id:'organicCompareValues',afterDatasetsDraw(chart) {
    const bar=chart.config.type==='bar',ctx=chart.ctx;
    if(!bar && chart.data.labels.length>10)return;
    ctx.save();ctx.font='600 12px Arial';ctx.textBaseline='alphabetic';
    chart.data.datasets.forEach((dataset,j)=>{
      ctx.fillStyle=colors[j];ctx.textAlign=bar?'left':'center';
      chart.getDatasetMeta(j).data.forEach((point,i)=>ctx.fillText(String(dataset.data[i]),point.x+(bar?7:0),point.y+(bar?4:j===1?19:-12)));
    });ctx.restore();
  }};
  return {
    moDestroyCompareCharts() { charts.forEach(chart=>chart.destroy());charts=[]; },
    moRenderCompareCharts() {
      this.moDestroyCompareCharts();
      if(this.moAnalysisTab!=='compare' || this.moCompareLoading || typeof Chart==='undefined')return;
      const line=this.moCompareTimeline(), bars=this.moCompareFunnel(), names=[0,1].map(i=>this.moCompareLabel(i));
      const axes={grid:{color:'#e8edf4'},ticks:{color:'#40547b',font:{size:11},precision:0}};
      if(line && this.$refs.moCompareLine)charts.push(new Chart(this.$refs.moCompareLine,{
        type:'line',data:{labels:line.labels,datasets:[line.a,line.b].map((data,i)=>({label:names[i],data,borderColor:colors[i],backgroundColor:colors[i],
          pointBackgroundColor:colors[i],pointBorderColor:'#fff',pointBorderWidth:1.5,pointRadius:5,borderWidth:2.5,tension:0}))},plugins:[values],
        options:{responsive:true,maintainAspectRatio:false,animation:false,layout:{padding:{top:30,right:22,bottom:8}},
          plugins:{legend:{display:false}},interaction:{mode:'index',intersect:false},
          scales:{x:{...axes,ticks:{...axes.ticks,maxRotation:0,maxTicksLimit:7}},y:{...axes,beginAtZero:true,ticks:{...axes.ticks,maxTicksLimit:4}}}}
      }));
      if(bars && this.$refs.moCompareBars)charts.push(new Chart(this.$refs.moCompareBars,{
        type:'bar',data:{labels:['Privadas enviadas','Conversas','Vendas'],datasets:[0,1].map(i=>({label:names[i],data:bars.map(row=>row.values[i]),
          backgroundColor:colors[i],borderRadius:2,barThickness:17}))},plugins:[values],
        options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,animation:false,layout:{padding:{top:8,right:35,bottom:8}},
          plugins:{legend:{display:false}},scales:{x:{...axes,beginAtZero:true},y:{...axes,grid:{display:false},ticks:{...axes.ticks,autoSkip:false}}}}
      }));
    },
  };
};
