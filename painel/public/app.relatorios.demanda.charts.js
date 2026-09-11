window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosDemandaCharts=function(){return{
  get rdemChartSvg(){const rows=this.rdemSeries;if(!rows.length)return'';
    const max=Math.max(2,...rows.flatMap(r=>[r.current,r.previous||0])),top=Math.ceil(max/2)*2,x=i=>52+i*652/Math.max(1,rows.length-1),y=n=>216-n/top*174;
    let svg='';for(const value of [0,top/2,top]){const py=y(value);svg+='<line x1="52" x2="704" y1="'+py+'" y2="'+py+'" stroke="#e3ebe9"/><text x="42" y="'+(py+4)+'" text-anchor="end" font-size="11" fill="#627489">'+this.rpNumber(value)+'</text>';}
    const points=rows.map((r,i)=>x(i)+','+y(r.current)).join(' ');svg+='<polygon points="52,216 '+points+' '+x(rows.length-1)+',216" fill="#ecf8f1"/>';
    if(rows[0].previous!==null)svg+='<polyline points="'+rows.map((r,i)=>x(i)+','+y(r.previous)).join(' ')+'" fill="none" stroke="#d49b38" stroke-width="2" stroke-dasharray="6 5"/>';
    svg+='<polyline points="'+points+'" fill="none" stroke="#007b60" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
    const step=Math.max(1,Math.ceil(rows.length/8));rows.forEach((r,i)=>{
      const label=r.from.slice(8)+'/'+r.from.slice(5,7);if(i%step===0||i===rows.length-1)svg+='<text x="'+x(i)+'" y="244" font-size="10" text-anchor="middle" fill="#627489">'+label+'</text>';
      svg+='<circle cx="'+x(i)+'" cy="'+y(r.current)+'" r="'+(rows.length>40?'2':'4')+'" fill="#007b60" stroke="white" stroke-width="1.5"><title>'+label+(r.from!==r.to?' a '+r.to.slice(8)+'/'+r.to.slice(5,7):'')+': '+r.current+(r.previous===null?'':' · anterior: '+r.previous)+'</title></circle>';
    });return svg;
  },
};};
