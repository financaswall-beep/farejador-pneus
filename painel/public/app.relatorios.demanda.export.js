window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosDemandaExport=function(){return{
  async rdemExport(format){if(!this.rdem.data||this.rdem.loading||this.rdem.exporting||this.rdemUnapplied)return;
    const filters={...this.rdem.data.filters};Object.assign(this.rdem,{exporting:true,exportError:''});
    try{const response=await fetch('/admin/api/relatorios/demanda/'+(format==='csv'?'exportar':'imprimir')+'?'+this.rdemQuery(filters),{credentials:'same-origin',headers:this.apiHeaders()});
      if(response.status===401)this.adminUnauthorized();if(!response.ok)throw Error(response.status===422?'Reduza o período para exportar.':'Não foi possível exportar o relatório.');
      const blob=format==='csv'?await response.blob():new Blob([this.rdemPdfBytes(await response.json())],{type:'application/pdf'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='demanda-'+filters.view+'-'+filters.from+'-'+filters.to+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){this.rdem.exportError=error.message;}finally{this.rdem.exporting=false;}
  },
};};
