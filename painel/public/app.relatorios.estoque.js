window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosEstoque=function(){
  let request=0;
  return {
    rst:{tab:'overview',days:'30',condition:'',status:'all',measure:'',exact:false,movement:'all',source:'all',offset:0,
      page:1,selected:'',data:null,loading:false,error:'',exporting:false,exportError:'',saved:false,notice:'',showRules:false,openingPlan:false},
    rstOpen(){try{this.rst.saved=!!localStorage.getItem(this.rstStorageKey());}catch(_){}void this.rstLoad();},
    rstQuery(filters=null,view=this.rst.tab){const f=filters||this.rst;return new URLSearchParams({days:f.days,condition:f.condition,
      status:f.status,measure:f.measure,exact:String(f.exact),view,movement:f.movement,source:f.source,offset:String(f.offset||0)}).toString();},
    async rstLoad(offset=0){
      const id=++request;Object.assign(this.rst,{loading:true,error:'',exportError:'',offset,page:1});
      try{
        const data=await this.apiGet('/admin/api/relatorios/estoque?'+this.rstQuery());if(id!==request)return;
        this.rst.data=data;
        if(!data.groups.some(row=>row.key===this.rst.selected))this.rst.selected=data.groups[0]?.key||'';
      }catch(error){if(id===request){this.rst.data=null;this.rst.selected='';this.rst.error=String(error.message).includes('422')
        ?'O relatório excedeu o limite de dados. Use uma base de giro menor; se persistir, solicite uma revisão do volume de cadastros.'
        :'Não foi possível consultar o estoque. Tente novamente.';}}
      finally{if(id===request)this.rst.loading=false;}
    },
    rstReset(){Object.assign(this.rst,{condition:'',status:'all',measure:'',exact:false,movement:'all',source:'all'});void this.rstLoad();},
    rstSearch(){this.rst.exact=false;void this.rstLoad();},
    rstTab(tab){this.rst.tab=tab;this.rst.page=1;if(tab==='replenishment'&&!this.rstRows.some(row=>row.key===this.rst.selected))this.rst.selected=this.rstRows[0]?.key||'';},
    rstSeeMovements(row){Object.assign(this.rst,{tab:'movements',measure:row.measure,condition:row.condition,exact:true,status:'all',movement:'all',source:'all'});void this.rstLoad();},
    rstStorageKey(){return this.rpStorageKey()+':estoque';},
    rstSaveView(){
      if(!this.rst.data||this.rst.loading||this.rstUnapplied)return;
      try{localStorage.setItem(this.rstStorageKey(),JSON.stringify({filters:this.rst.data.filters,tab:this.rst.tab}));this.rst.saved=true;this.rst.notice='Visão de estoque salva neste navegador. O saldo será consultado novamente ao restaurar.';}
      catch(_){this.rst.notice='O navegador não permitiu salvar a visão.';}
    },
    rstRestoreView(){
      try{const value=JSON.parse(localStorage.getItem(this.rstStorageKey())||'null');if(!value?.filters)return;
        for(const key of ['days','condition','status','measure','movement','source']){if(typeof value.filters[key]!=='string'||value.filters[key].length>200)throw Error('invalid');this.rst[key]=value.filters[key];}
        this.rst.exact=String(value.filters.exact)==='true';this.rst.tab=['overview','products','replenishment','movements'].includes(value.tab)?value.tab:'overview';
        this.rst.notice='Visão restaurada com o estoque atual.';void this.rstLoad();
      }catch(_){this.rst.notice='A visão salva não está disponível. Selecione os filtros novamente.';}
    },
    async rstOpenPlan(){
      if(!this.hasPanelModule('compras')||this.rst.openingPlan)return;
      const chosen=this.rstSelected;this.rst.openingPlan=true;this.rst.error='';
      try{
        const [stock,prices]=await Promise.all([this.apiGet('/admin/api/relatorios/estoque?days=30'),this.apiGet('/admin/api/wholesale/suppliers/prices?period=all')]);
        const variants=stock.groups.flatMap(row=>row.brands.map(item=>({measure:row.measure,tire_condition:row.condition,brand:item.brand,
          quantity_on_hand:item.physical,quantity_reserved:item.reserved,quantity_available:item.available,
          in_transit_quantity:item.incoming,sales_30d:item.sold,min_quantity:row.minimum})));
        // Reuse the existing price selection and purchase draft flow with a complete current stock snapshot.
        this.comprasReplenishment={...this.comprasReplenishment,rows:this.comprasReplenishmentBuild(variants,prices.rows||[]),
          generatedAt:stock.as_of,loading:false,error:null,noMinimum:stock.summary.no_minimum,period:'all',
          search:chosen?.measure||'',condition:chosen?.condition||'all',onlyCompetition:false};
        this.comprasTab='precos';this.comprasPriceMode='plan';this.currentPage='compras';
        this.$nextTick(()=>window.lucide&&window.lucide.createIcons());
      }catch(_){this.rst.error='Não foi possível abrir o plano de Compras. Tente novamente.';}finally{this.rst.openingPlan=false;}
    },
  };
};
