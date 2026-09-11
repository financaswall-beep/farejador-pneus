window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosFinanceiroExport=function(){return{
  async rfinExport(format){if(!this.rfin.data||this.rfin.loading||this.rfin.exporting||this.rfinUnapplied)return;
    const filters={...this.rfin.data.filters},tab=this.rfin.tab;Object.assign(this.rfin,{exporting:true,exportError:''});
    try{const response=await fetch('/admin/api/relatorios/financeiro/'+(format==='csv'?'exportar':'imprimir')+'?'+this.rfinQuery(filters,tab),{credentials:'same-origin',headers:this.apiHeaders()});
      if(response.status===401)this.adminUnauthorized();if(!response.ok)throw Error(response.status===422?'Selecione um intervalo menor para exportar.':'Não foi possível exportar o relatório.');
      const blob=format==='csv'?await response.blob():new Blob([this.rfinPdfBytes(await response.json(),tab)],{type:'application/pdf'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='financeiro-'+tab+'-'+filters.from+'-'+filters.to+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){this.rfin.exportError=error.message;}finally{this.rfin.exporting=false;}
  },
};};
