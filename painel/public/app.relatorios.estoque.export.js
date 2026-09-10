window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosEstoqueExport=function(){return {
  async rstExport(format){
    if(!this.rst.data||this.rst.loading||this.rstUnapplied||this.rst.exporting)return;
    const filters={...this.rst.data.filters},tab=this.rst.tab;this.rst.exporting=true;this.rst.exportError='';
    try{
      const response=await fetch('/admin/api/relatorios/estoque/'+(format==='csv'?'exportar':'imprimir')+'?'+this.rstQuery(filters,tab),{credentials:'same-origin',headers:this.apiHeaders()});
      if(response.status===401)this.adminUnauthorized();
      if(!response.ok)throw Error(response.status===422?'Reduza a base do giro para exportar.':'Não foi possível exportar. Tente novamente.');
      const blob=format==='csv'?await response.blob():new Blob([this.rstPdfBytes(await response.json(),tab)],{type:'application/pdf'});
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='estoque-'+tab+'-'+new Date().toISOString().slice(0,10)+'.'+format;
      link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){this.rst.exportError=error.message;}finally{this.rst.exporting=false;}
  },
};};
