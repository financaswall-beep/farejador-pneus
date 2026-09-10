window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botFaltas = function () {
  let request = 0, detailRequest = 0;
  const day = d => d.toISOString().slice(0,10);
  const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const date = value => new Date(value+'T12:00:00Z');
  return {
    bf: { mode:'month', anchor:today(), from:'', to:'', draftFrom:'', draftTo:'', search:'', store:'', measure:'',
      data:null, loading:false, error:'', details:[], stock:[], selected:null, detailLoading:false,
      detailError:'', total:0, offset:0, showAll:false, exporting:false, exportError:'' },
    bfOpen() { this.botTab='faltas'; if(!this.bf.from) this.bfPeriod('month'); else void this.bfLoad(); },
    bfPeriod(mode, step=0) {
      if(mode!==this.bf.mode && mode!=='custom')this.bf.anchor=this.bf.to||today();
      this.bf.mode=mode;
      if(mode==='custom') {this.bf.draftFrom=this.bf.from;this.bf.draftTo=this.bf.to;return;}
      const anchor=date(this.bf.anchor);
      if(mode==='month') anchor.setUTCDate(1),anchor.setUTCMonth(anchor.getUTCMonth()+step);
      else anchor.setUTCDate(anchor.getUTCDate()+step*7);
      this.bf.anchor=day(anchor)>today()?today():day(anchor);
      const start=date(this.bf.anchor),end=date(this.bf.anchor);
      if(mode==='month') {start.setUTCDate(1);end.setUTCMonth(end.getUTCMonth()+1,0);}
      else {start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);end.setTime(start.getTime());end.setUTCDate(end.getUTCDate()+6);}
      this.bf.from=day(start);this.bf.to=day(end)>today()?today():day(end);
      void this.bfLoad();
    },
    get bfPeriodLabel() {
      if(!this.bf.from) return '';
      if(this.bf.mode==='month') return date(this.bf.from).toLocaleDateString('pt-BR',{month:'long',year:'numeric',timeZone:'UTC'});
      return date(this.bf.from).toLocaleDateString('pt-BR',{timeZone:'UTC'})+' — '+date(this.bf.to).toLocaleDateString('pt-BR',{timeZone:'UTC'});
    },
    bfQuery(extra={}) {return new URLSearchParams({from:this.bf.from,to:this.bf.to,...extra}).toString();},
    bfApplyPeriod() {this.bf.from=this.bf.draftFrom;this.bf.to=this.bf.draftTo;void this.bfLoad();},
    async bfLoad() {
      const id=++request;++detailRequest;
      Object.assign(this.bf,{loading:true,error:'',data:null,details:[],selected:null,detailLoading:false,exportError:''});
      if(!this.bf.from||!this.bf.to||this.bf.from>this.bf.to||this.bf.to>today()||date(this.bf.to)-date(this.bf.from)>365*86400000) {
        this.bf.error='Selecione um período válido de até 366 dias, encerrado até hoje.';this.bf.loading=false;return;
      }
      try {
        const data=await this.apiGet('/admin/api/bot/faltas?'+this.bfQuery());
        if(id!==request)return;
        this.bf.data=data;
        if(!this.bfStores.some(s=>s.id===this.bf.store))this.bf.store='';
        this.bf.loading=false;this.bfFilter();
      } catch(err) {if(id===request)this.bf.error='Não foi possível carregar as faltas. Tente novamente.';}
      finally {if(id===request)this.bf.loading=false;}
    },
    get bfStores() {
      const grouped=new Map();
      for(const row of this.bf.data?.counts||[]) {
        const item=grouped.get(row.store_id)||{id:row.store_id,name:row.store_name,count:0};
        item.count+=row.shortages;grouped.set(row.store_id,item);
      }
      return [...grouped.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name));
    },
    get bfMeasures() {
      const grouped=new Map(),query=this.bf.search.trim().toUpperCase().replace(/\s/g,'');
      for(const row of this.bf.data?.counts||[]) {
        if((this.bf.store&&row.store_id!==this.bf.store)||!row.measure.replace(/\s/g,'').includes(query))continue;
        const item=grouped.get(row.measure)||{measure:row.measure,count:0,stores:[]};
        item.count+=row.shortages;item.stores.push(row.store_name+' '+row.shortages);grouped.set(row.measure,item);
      }
      return [...grouped.values()].sort((a,b)=>b.count-a.count||a.measure.localeCompare(b.measure));
    },
    get bfStoreName() {return this.bfStores.find(s=>s.id===this.bf.store)?.name||'Todas as lojas';},
    bfFilter(store=this.bf.store) {
      this.bf.store=store;
      const selected=this.bfMeasures.find(m=>m.measure===this.bf.measure)||this.bfMeasures[0];
      this.bfChooseMeasure(selected?.measure||'');
    },
    bfChooseMeasure(measure) {this.bf.measure=measure;this.bf.offset=0;this.bf.showAll=false;void this.bfLoadDetails();},
    async bfLoadDetails(offset=0) {
      const id=++detailRequest;
      Object.assign(this.bf,{details:[],selected:null,stock:[],total:0,offset,detailError:'',detailLoading:!!this.bf.measure});
      if(!this.bf.measure)return;
      try {
        const extra={measure:this.bf.measure,offset};if(this.bf.store)extra.store=this.bf.store;
        const data=await this.apiGet('/admin/api/bot/faltas/consultas?'+this.bfQuery(extra));
        if(id!==detailRequest)return;
        Object.assign(this.bf,{details:data.rows,stock:data.stock,total:data.total,selected:data.rows[0]||null});
      }catch(err){if(id===detailRequest)this.bf.detailError='Não foi possível carregar estas consultas.';}
      finally{if(id===detailRequest)this.bf.detailLoading=false;}
    },
    bfDate(value) {return value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';},
    bfStock(id) {const q=this.bf.stock.find(s=>s.store_id===id)?.quantity;return q==null?'Sem registro':q>0?q+' un':'Zerado';},
    get bfOutcome() {return this.bf.selected?.stores.some(s=>s.available)?'Havia disponibilidade nas lojas consultadas.':'Sem disponibilidade nas lojas consultadas.';},
    get bfScope() {
      const f=this.bf.selected?.filters||{};
      return [f.marca,f.condicao_pneu?.replace(/_/g,' '),({front:'dianteiro',rear:'traseiro',both:'ambas posições'})[f.posicao_pneu]].filter(Boolean).join(' · ');
    },
    async bfExport() {
      this.bf.exporting=true;this.bf.exportError='';
      try {
        const extra={};if(this.bf.store)extra.store=this.bf.store;if(this.bf.search.trim())extra.measure=this.bf.search.trim();
        const response=await fetch('/admin/api/bot/faltas/exportar?'+this.bfQuery(extra),{credentials:'same-origin',headers:this.apiHeaders()});
        if(response.status===401)this.adminUnauthorized();
        if(!response.ok)throw new Error(response.status===422?'Reduza o período ou filtre uma loja para exportar até 10 mil faltas.':'Não foi possível exportar o relatório.');
        const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');
        a.href=url;a.download='faltas-'+this.bf.from+'-'+this.bf.to+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }catch(err){this.bf.exportError=err.message;}
      finally{this.bf.exporting=false;}
    },
  };
};
