window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.relatoriosExport = function () {
  return {
    async rpExport(format) {
      if(!this.rp.data||this.rp.loading||this.rp.exporting||this.rpUnapplied)return;
      this.rp.exporting=true;this.rp.exportError='';
      const filters={...this.rp.data.filters},tab=this.rp.tab;
      try {
        const response=await fetch('/admin/api/relatorios/vendas/'+(format==='csv'?'exportar':'imprimir')+'?'+this.rpQuery(filters),
          {credentials:'same-origin',headers:this.apiHeaders()});
        if(response.status===401)this.adminUnauthorized();
        if(!response.ok)throw Error(response.status===422?'Reduza o período para exportar este relatório.':'Não foi possível exportar. Tente novamente.');
        let blob;
        if(format==='csv')blob=await response.blob();
        else {
          const report=await response.json();
          blob=new Blob([this.rpPdfBytes(report,tab)],{type:'application/pdf'});
        }
        const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;
        link.download='vendas-matriz-'+filters.from+'-'+filters.to+'.'+format;link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      }catch(err){this.rp.exportError=err.message;}
      finally{this.rp.exporting=false;}
    },
  };
};
