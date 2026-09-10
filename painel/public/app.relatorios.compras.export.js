window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.relatoriosComprasExport = function () {
  return {
    async rcompExport(format) {
      if(!this.rcomp.data||this.rcomp.loading||this.rcomp.exporting||this.rcompUnapplied)return;
      this.rcomp.exporting=true;this.rcomp.exportError='';
      const filters={...this.rcomp.data.filters},tab=this.rcomp.tab;
      try{
        const response=await fetch('/admin/api/relatorios/compras/'+(format==='csv'?'exportar':'imprimir')+'?'+this.rcompQuery(filters,tab),
          {credentials:'same-origin',headers:this.apiHeaders()});
        if(response.status===401)this.adminUnauthorized();
        if(!response.ok)throw Error(response.status===422?'Reduza o período para exportar este relatório.':'Não foi possível exportar. Tente novamente.');
        const blob=format==='csv'?await response.blob():new Blob([this.rcompPdfBytes(await response.json(),tab)],{type:'application/pdf'});
        const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;
        link.download='compras-'+tab+'-'+filters.from+'-'+filters.to+'.'+format;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }catch(err){this.rcomp.exportError=err.message;}finally{this.rcomp.exporting=false;}
    },
  };
};
