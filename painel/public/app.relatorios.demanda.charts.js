window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosDemandaCharts=function(){return{
  get rdemChartSvg(){const rows=this.rdemSeries;if(!rows.length)return'';
    const compact=this.rdem.tab==='measures',max=Math.max(2,...rows.flatMap(r=>[r.current,compact?0:r.previous||0])),top=Math.ceil(max/2)*2,x=i=>52+i*652/Math.max(1,rows.length-1),y=n=>216-n/top*174;
    let svg='';for(const value of [0,top/2,top]){const py=y(value);svg+='<line x1="52" x2="704" y1="'+py+'" y2="'+py+'" stroke="#e3ebe9"/><text x="42" y="'+(py+4)+'" text-anchor="end" font-size="'+(compact?15:11)+'" fill="#627489">'+this.rpNumber(value)+'</text>';}
    if(compact){svg+='<defs><linearGradient id="rdem-measure-area" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#88d8bc" stop-opacity=".5"/><stop offset="1" stop-color="#dcf4eb" stop-opacity=".3"/></linearGradient></defs>';rows.forEach((_,i)=>{if(rows.length<=16||i%Math.ceil(rows.length/12)===0)svg+='<line x1="'+x(i)+'" x2="'+x(i)+'" y1="42" y2="224" stroke="#e3ebe9"/>';});}
    const points=rows.map((r,i)=>x(i)+','+y(r.current)).join(' ');svg+='<polygon points="52,216 '+points+' '+x(rows.length-1)+',216" fill="'+(compact?'url(#rdem-measure-area)':'#ecf8f1')+'"/>';
    if(!compact&&rows[0].previous!==null)svg+='<polyline points="'+rows.map((r,i)=>x(i)+','+y(r.previous)).join(' ')+'" fill="none" stroke="#d49b38" stroke-width="2" stroke-dasharray="6 5"/>';
    svg+='<polyline points="'+points+'" fill="none" stroke="#007b60" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
    const step=Math.max(1,Math.ceil(rows.length/(compact?12:8)));rows.forEach((r,i)=>{
      const label=r.from.slice(8)+'/'+r.from.slice(5,7);if(i%step===0||i===rows.length-1)svg+='<text x="'+x(i)+'" y="244" font-size="'+(compact?14:10)+'" text-anchor="middle" fill="#627489">'+label+'</text>';
      svg+='<circle cx="'+x(i)+'" cy="'+y(r.current)+'" r="'+(rows.length>40?'2':compact?'5.5':'4')+'" fill="#007b60" stroke="white" stroke-width="1.5"><title>'+label+(r.from!==r.to?' a '+r.to.slice(8)+'/'+r.to.slice(5,7):'')+': '+r.current+(r.previous===null?'':' · anterior: '+r.previous)+'</title></circle>';
    });return svg;
  },
};};
