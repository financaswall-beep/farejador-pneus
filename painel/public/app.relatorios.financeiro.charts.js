window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosFinanceiroCharts=function(){return{
  get rfinResultSvg(){
    const rows=this.rfin.data?.daily||[];if(!rows.length)return'';
    const low=Math.min(0,...rows.map(r=>r.cumulative)),high=Math.max(1,...rows.map(r=>r.cumulative)),span=high-low;
    const x=i=>52+i*680/Math.max(1,rows.length-1),y=n=>110-(n-low)/span*90;
    const points=rows.map((r,i)=>[x(i),y(r.cumulative)]),baseline=y(0),path=points.map(p=>p.join(',')).join(' ');
    let svg='';
    for(const value of [...new Set([low,(high+low)/2,high])]){const py=y(value),label=Math.abs(value)>=1000?(value/1000).toLocaleString('pt-BR',{maximumFractionDigits:1})+' mil':Math.round(value).toLocaleString('pt-BR');
      svg+='<line x1="52" x2="732" y1="'+py+'" y2="'+py+'" stroke="#e6eeeb"/><text x="44" y="'+(py+3)+'" text-anchor="end" fill="#65798a" font-size="10">'+label+'</text>';}
    svg+='<polygon points="'+points[0][0]+','+baseline+' '+path+' '+points.at(-1)[0]+','+baseline+'" fill="#e6f4ee" opacity=".65"/>';
    svg+='<polyline points="'+path+'" fill="none" stroke="#007960" stroke-width="2.5" stroke-linejoin="round"/>';
    const step=Math.max(1,Math.ceil(rows.length/10));
    rows.forEach((row,i)=>{if(i%step!==0&&i!==rows.length-1)return;svg+='<circle cx="'+x(i)+'" cy="'+y(row.cumulative)+'" r="3.2" fill="#007960" stroke="white" stroke-width="1"/>';
      svg+='<text x="'+x(i)+'" y="132" text-anchor="middle" fill="#65798a" font-size="10">'+row.day.slice(8)+'/'+row.day.slice(5,7)+'</text>';});
    return svg;
  },
};};
