window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosParceirosExport=function(){return{
  async rparExport(format){if(!this.rpar.data||this.rpar.loading||this.rpar.exporting||this.rparUnapplied)return;
    const filters={...this.rpar.data.filters},tab=this.rpar.tab;Object.assign(this.rpar,{exporting:true,exportError:''});
    try{const response=await fetch('/admin/api/relatorios/parceiros/'+(format==='csv'?'exportar':'imprimir')+'?'+this.rparQuery(filters,tab),{credentials:'same-origin',headers:this.apiHeaders()});
      if(response.status===401)this.adminUnauthorized();if(!response.ok)throw Error(response.status===422?'Reduza o período para exportar.':'Não foi possível exportar o relatório.');
      const blob=format==='csv'?await response.blob():new Blob([this.rparPdfBytes(await response.json(),tab)],{type:'application/pdf'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='parceiros-'+tab+'-'+filters.from+'-'+filters.to+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){this.rpar.exportError=error.message;}finally{this.rpar.exporting=false;}
  },
};};
