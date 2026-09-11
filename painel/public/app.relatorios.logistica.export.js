window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosLogisticaExport=function(){return {
  async rlogExport(format){
    if(!this.rlog.data||this.rlog.loading||this.rlogUnapplied||this.rlog.exporting)return;
    const filters={...this.rlog.data.filters},tab=this.rlog.tab;this.rlog.exporting=true;this.rlog.exportError='';
    try{const response=await fetch('/admin/api/relatorios/logistica/'+(format==='csv'?'exportar':'imprimir')+'?'+this.rlogQuery(filters,tab),{credentials:'same-origin',headers:this.apiHeaders()});
      if(response.status===401)this.adminUnauthorized();if(!response.ok)throw Error(response.status===422?'Selecione um período menor para exportar.':'Não foi possível exportar o relatório.');
      const blob=format==='csv'?await response.blob():new Blob([this.rlogPdfBytes(await response.json(),tab)],{type:'application/pdf'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='logistica-'+tab+'-'+filters.from+'-'+filters.to+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){this.rlog.exportError=error.message;}finally{this.rlog.exporting=false;}
  },
};};
