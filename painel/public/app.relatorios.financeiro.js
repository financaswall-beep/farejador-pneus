window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosFinanceiro=function(){
  let request=0;const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
  const parse=day=>new Date(day+'T12:00:00Z'),date=d=>d.toISOString().slice(0,10);
  return{
    rfin:{tab:'overview',from:'',to:'',month:today().slice(0,7),mode:'month',origin:'all',search:'',flow:'realized',horizon:30,
      direction:'all',cash_day:'',result_kind:'all',title_side:'all',due:'all',data:null,loading:false,error:'',page:1,selected:'',agendaSide:'receivable',
      exporting:false,exportError:'',saved:false,notice:'',showRules:false},
    rfinOpen(){try{this.rfin.saved=!!localStorage.getItem(this.rfinStorageKey());}catch(_){}if(!this.rfin.from)this.rfinPeriod('month');else void this.rfinLoad();},
    rfinPeriod(mode,step=0){const old=this.rfin.mode;this.rfin.mode=mode;this.rfin.cash_day='';if(mode==='custom')return;
      let from,to;
      if(mode==='month'){from=parse((this.rfin.month||today().slice(0,7))+'-01');from.setUTCMonth(from.getUTCMonth()+step);if(date(from)>today())from=parse(today().slice(0,7)+'-01');
        to=new Date(from);to.setUTCMonth(to.getUTCMonth()+1,0);this.rfin.month=date(from).slice(0,7);
      }else{from=parse(old==='week'&&this.rfin.from?this.rfin.from:today());from.setUTCDate(from.getUTCDate()-(from.getUTCDay()+6)%7+step*7);
        if(date(from)>today()){from=parse(today());from.setUTCDate(from.getUTCDate()-(from.getUTCDay()+6)%7);}to=new Date(from);to.setUTCDate(to.getUTCDate()+6);}
      this.rfin.from=date(from);this.rfin.to=date(to)>today()?today():date(to);void this.rfinLoad();
    },
    rfinQuery(filters=null,view=this.rfin.tab){const f=filters||this.rfin;return new URLSearchParams({from:f.from,to:f.to,mode:f.mode,origin:f.origin,search:f.search,
      flow:f.flow,horizon:String(f.horizon),direction:f.direction,cash_day:f.cash_day,result_kind:f.result_kind,title_side:f.title_side,due:f.due,view}).toString();},
    async rfinLoad(){const id=++request;Object.assign(this.rfin,{loading:true,error:'',exportError:'',page:1});
      const from=parse(this.rfin.from),to=parse(this.rfin.to);
      if(!Number.isFinite(+from)||!Number.isFinite(+to)||date(from)!==this.rfin.from||date(to)!==this.rfin.to||from>to||this.rfin.to>today()||to-from>365*86400000){
        this.rfin.data=null;this.rfin.error='Escolha um período válido de até 366 dias, encerrado até hoje.';this.rfin.loading=false;return;}
      try{const data=await this.apiGet('/admin/api/relatorios/financeiro?'+this.rfinQuery());if(id!==request)return;this.rfin.data=data;this.rfinEnsureSelection();}
      catch(error){if(id===request){this.rfin.data=null;this.rfin.selected='';this.rfin.error=String(error.message).includes('409')?
        'A leitura financeira está desativada ou há uma divergência de integração. Confira o módulo Financeiro.':String(error.message).includes('422')?
        'O período tem muitos registros. Selecione um intervalo menor.':'Não foi possível consultar o relatório financeiro. Tente novamente.';}}
      finally{if(id===request)this.rfin.loading=false;}
    },
    rfinTab(tab){this.rfin.tab=tab;this.rfin.page=1;this.rfinEnsureSelection();},
    rfinEnsureSelection(){if(!this.rfinRows.some(row=>row.id===this.rfin.selected))this.rfin.selected=this.rfinRows[0]?.id||'';},
    rfinSelectDay(day){this.rfin.cash_day=this.rfin.cash_day===day?'':day;void this.rfinLoad();},
    rfinReset(){Object.assign(this.rfin,{origin:'all',search:'',direction:'all',cash_day:'',result_kind:'all',title_side:'all',due:'all'});void this.rfinLoad();},
    rfinShowTitles(side='all',due='all',id=''){Object.assign(this.rfin,{tab:'titles',title_side:side,due,search:'',selected:id});void this.rfinLoad();},
    rfinShowResult(category=''){Object.assign(this.rfin,{tab:'result',search:category,result_kind:category?'expense':'all'});void this.rfinLoad();},
    rfinStorageKey(){return this.rpStorageKey()+':financeiro';},
    rfinSaveView(){if(!this.rfin.data||this.rfin.loading||this.rfinUnapplied)return;try{localStorage.setItem(this.rfinStorageKey(),JSON.stringify({filters:this.rfin.data.filters,tab:this.rfin.tab}));
      this.rfin.saved=true;this.rfin.notice='Visão financeira salva neste navegador.';}catch(_){this.rfin.notice='O navegador não permitiu salvar a visão.';}},
    rfinRestoreView(){try{const saved=JSON.parse(localStorage.getItem(this.rfinStorageKey())||'null');if(!saved?.filters)return;
      for(const key of ['from','to','mode','origin','search','flow','direction','cash_day','result_kind','title_side','due']){
        if(typeof saved.filters[key]!=='string'||saved.filters[key].length>200)throw Error('invalid');this.rfin[key]=saved.filters[key];}
      this.rfin.horizon=[7,30,90].includes(saved.filters.horizon)?saved.filters.horizon:30;this.rfin.month=this.rfin.from.slice(0,7);
      this.rfin.tab=['overview','result','cash','titles'].includes(saved.tab)?saved.tab:'overview';this.rfin.notice='Visão restaurada. Os valores foram consultados novamente.';void this.rfinLoad();
    }catch(_){this.rfin.notice='Não foi possível restaurar a visão. Escolha os filtros novamente.';}},
    rfinOpenOrigin(row){const module=['atacado','varejo'].includes(row.origin)?'vendas':row.origin==='compras'?'compras':'financeiro';
      if(this.hasPanelModule(module))this.currentPage=module;},
  };
};
