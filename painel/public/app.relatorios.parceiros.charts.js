window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosParceirosCharts=function(){return{
  get rparChartSvg(){const rows=this.rpar.data?.daily||[];if(!rows.length)return'';
    const max=Math.max(1,...rows.flatMap(r=>[r.sales,r.previous||0])),x=i=>64+i*650/Math.max(1,rows.length-1),y=n=>158-n/max*125;
    let svg='';for(const value of [0,max/2,max]){const py=y(value),label=value>=1000?'R$ '+(value/1000).toLocaleString('pt-BR',{maximumFractionDigits:1})+' mil':'R$ '+Math.round(value);
      svg+='<line x1="64" x2="714" y1="'+py+'" y2="'+py+'" stroke="#e4ece9"/><text x="56" y="'+(py+4)+'" text-anchor="end" font-size="11" fill="#627489">'+label+'</text>';}
    const path=rows.map((r,i)=>x(i)+','+y(r.sales)).join(' ');svg+='<polygon points="64,158 '+path+' '+x(rows.length-1)+',158" fill="#e7f5ee"/>';
    const old=rows.map((r,i)=>r.previous===null?null:x(i)+','+y(r.previous));let segment=[];
    for(const point of [...old,null]){if(point)segment.push(point);else if(segment.length){svg+='<polyline points="'+segment.join(' ')+'" fill="none" stroke="#d49b38" stroke-width="1.8" stroke-dasharray="5 4"/>';segment=[];}}
    svg+='<polyline points="'+path+'" fill="none" stroke="#007a61" stroke-width="2.5" stroke-linejoin="round"/>';
    const step=Math.max(1,Math.ceil(rows.length/9));rows.forEach((r,i)=>{if(i%step&&i!==rows.length-1)return;svg+='<circle cx="'+x(i)+'" cy="'+y(r.sales)+'" r="3.5" fill="#007a61"/>'
      +'<text x="'+x(i)+'" y="180" font-size="10" text-anchor="middle" fill="#627489">'+r.day.slice(8)+'/'+r.day.slice(5,7)+'</text>';});return svg;
  },
};};
