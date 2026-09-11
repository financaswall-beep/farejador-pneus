window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosFaltasExport=function(){return{
  async rfalExport(format){if(!this.rfal.data||this.rfal.loading||this.rfal.exporting||this.rfalUnapplied)return;
    const filters={...this.rfal.data.filters},tab=this.rfal.tab;Object.assign(this.rfal,{exporting:true,exportError:''});
    try{const response=await fetch('/admin/api/relatorios/faltas/'+(format==='csv'?'exportar':'imprimir')+'?'+this.rfalQuery(filters,tab),{credentials:'same-origin',headers:this.apiHeaders()});
      if(response.status===401)this.adminUnauthorized();if(!response.ok)throw Error(response.status===422?'Reduza o período para exportar.':'Não foi possível exportar o relatório.');
      const blob=format==='csv'?await response.blob():new Blob([this.rfalPdfBytes(await response.json(),tab)],{type:'application/pdf'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='faltas-'+tab+'-'+filters.from+'-'+filters.to+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){this.rfal.exportError=error.message;}finally{this.rfal.exporting=false;}
  },
};};
