window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosDemandaCharts=function(){return{
  get rdemChartSvg(){if(this.rdem.tab==='evolution')return this.rdemEvolutionChartSvg;const rows=this.rdemSeries;if(!rows.length)return'';
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
  get rdemEvolutionChartSvg(){
    const rows=this.rdemSeries;if(!rows.length)return'';
    const max=Math.max(1,...rows.flatMap(r=>[r.current,r.previous||0])),base=10**Math.floor(Math.log10(max/3));
    const tick=[1,2,5,10].map(n=>n*base).find(n=>n>=max/3),step=Math.max(1,tick),top=Math.ceil(max/step)*step;
    const left=42,right=1080,bottom=194,x=i=>rows.length===1?(left+right)/2:left+i*(right-left)/(rows.length-1),y=n=>bottom-n/top*171;
    let svg='<defs><linearGradient id="rdem-evolution-area" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#8bd6bc" stop-opacity=".48"/><stop offset="1" stop-color="#edf8f3" stop-opacity=".25"/></linearGradient></defs>';
    for(let value=0;value<=top;value+=step){const py=y(value);svg+='<line x1="'+left+'" x2="'+right+'" y1="'+py+'" y2="'+py+'" stroke="#e1e8ee"/><text x="31" y="'+(py+4)+'" font-size="12" text-anchor="end" fill="#536e93">'+this.rpNumber(value)+'</text>';}
    const labelStep=Math.max(1,Math.ceil(rows.length/12));
    rows.forEach((r,i)=>{if((i%labelStep===0&&i<rows.length-Math.max(1,labelStep/2))||i===rows.length-1){const px=x(i);svg+='<line x1="'+px+'" x2="'+px+'" y1="23" y2="202" stroke="#e1e8ee"/><text x="'+px+'" y="221" font-size="12" text-anchor="'+(i===rows.length-1?'end':i===0?'start':'middle')+'" fill="#536e93">'+this.rdemShortDate(r.from)+'</text>';}});
    const points=rows.map((r,i)=>x(i)+','+y(r.current)).join(' ');
    svg+='<polygon points="'+x(0)+','+bottom+' '+points+' '+x(rows.length-1)+','+bottom+'" fill="url(#rdem-evolution-area)"/>';
    if(rows[0].previous!==null)svg+='<polyline class="rdem-previous-curve" points="'+rows.map((r,i)=>x(i)+','+y(r.previous)).join(' ')+'" fill="none" stroke="#e9a027" stroke-width="1.8" stroke-dasharray="6 5"/>';
    svg+='<polyline points="'+points+'" fill="none" stroke="#008469" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>';
    rows.forEach((r,i)=>{const label=this.rdemShortDate(r.from)+(r.from!==r.to?' a '+this.rdemShortDate(r.to):''),radius=rows.length>40?2.5:5.2;
      if(r.previous!==null)svg+='<circle cx="'+x(i)+'" cy="'+y(r.previous)+'" r="'+radius+'" fill="#e9a027" stroke="white" stroke-width="1.4"><title>'+label+' · anterior: '+r.previous+'</title></circle>';
      svg+='<circle cx="'+x(i)+'" cy="'+y(r.current)+'" r="'+radius+'" fill="#008469" stroke="white" stroke-width="1.4"><title>'+label+': '+r.current+'</title></circle>';
    });return svg;
  },
};};
