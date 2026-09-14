window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.marketingGeographyActions=function(){return {
  mgConfigOpen:false,mgConfigCampaign:'',mgForm:null,mgFormError:'',mgOfferProduct:'',mgOfferAd:'',
  mgPlanOpen:false,mgPlanPercent:10,mgPlanDays:7,mgPlanKey:'',mgPlanResult:null,mgPlanError:'',mgPlanCampaign:null,
  mgTrapFocus(event){const fields=[...event.currentTarget.querySelectorAll('button,input,select,textarea,a[href]')].filter(e=>!e.disabled&&e.offsetParent!==null);const first=fields[0],last=fields.at(-1);if(!first)return;if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}},
  mgCloseDialogs(){if(this.mgBusy)return;this.mgConfigOpen=false;this.mgPlanOpen=false;this.mgInfo=false;},
  mgOpenConfig(){this.mgConfigOpen=true;this.mgFormError='';this.mgConfigCampaign=this.mgSelectedRecord()?.id||(this.mgData?.catalog||[]).find(c=>c.scope==='matrix')?.id||'';this.mgLoadForm();this.$nextTick(()=>this.$refs.mgConfigFocus?.focus());},
  mgLoadForm(){
    const saved=(this.mgData?.bindings||[]).find(b=>b.campaign_id===this.mgConfigCampaign);
    this.mgForm=saved?JSON.parse(JSON.stringify({...saved,expected_id:saved.id})):{expected_id:null,allocation:'shared',municipality:'',
      valid_from:this.mgData?.period?.until||'',valid_until:this.mgData?.period?.until||'',coverage:'unknown',offers:[],reason:''};
    this.mgOfferAd='';this.mgOfferProduct='';this.mgFormError='';
  },
  mgOfferOptions(){return this.mgData?.offers||[];},
  mgAdOptions(){return(this.mgData?.ads||[]).filter(a=>a.campaign_id===this.mgConfigCampaign);},
  mgAddOffer(){
    const product=this.mgOfferOptions()[Number(this.mgOfferProduct)];
    if(this.mgOfferProduct===''||!product||!this.mgAdOptions().some(a=>a.id===this.mgOfferAd)){this.mgFormError='Escolha um anúncio e um produto do catálogo.';return;}
    const offer={ad_id:this.mgOfferAd,...product};
    if(!this.mgForm.offers.some(o=>JSON.stringify(o)===JSON.stringify(offer)))this.mgForm.offers.push(offer);
    this.mgFormError='';
  },
  async mgSaveConfig(){
    if(this.mgBusy||!this.mgForm||!this.mgConfigCampaign)return;
    if(!this.mgForm.reason?.trim()||!this.mgForm.valid_from||!this.mgForm.valid_until){this.mgFormError='Preencha a validade e o motivo da classificação.';return;}
    const f=this.mgForm;const body={expected_id:f.expected_id,allocation:f.allocation,municipality:f.municipality?.trim()||null,
      valid_from:f.valid_from,valid_until:f.valid_until,coverage:f.coverage,offers:f.offers,reason:f.reason};
    this.mgBusy=true;this.mgFormError='';
    try{
      if(this.marketingIsMock()){this.mgFormError='Prévia ilustrativa: os vínculos não são gravados.';return;}
      await this.apiPost(`/admin/api/marketing/geography/${encodeURIComponent(this.mgConfigCampaign)}/binding`,body);
      this.mgConfigOpen=false;await this.loadMarketingGeography();this.mgNotice='Vínculo salvo com histórico. Os indicadores foram recalculados.';
    }catch(e){this.mgFormError=String(e?.message||'').includes('conflict')?'Outra pessoa alterou o vínculo. Atualize a tela antes de salvar.':'Não foi possível salvar. Confira os campos, o escopo da campanha e as ofertas.';}
    finally{this.mgBusy=false;}
  },
  async mgRefresh(){if(this.mgBusy)return;this.mgBusy=true;this.mgNotice='';try{
    if(!this.marketingIsMock())await this.apiPost('/admin/api/marketing/geography/refresh',{});
    await this.loadMarketingGeography();this.mgNotice='Configuração Meta atualizada. Gastos e vendas seguem o ciclo de sincronização de Integrações.';
  }catch{this.mgNotice='A Meta não pôde ser atualizada. Os dados já coletados continuam preservados.';}finally{this.mgBusy=false;}},
  mgCanPlan(){const c=this.mgSelectedRecord();return !this.mgLoading&&c?.decision==='increase'&&c.meta?.daily_budget>0&&!!c.meta.budget_entity_id;},
  mgOpenPlan(){if(!this.mgCanPlan())return;this.mgPlanCampaign=JSON.parse(JSON.stringify(this.mgSelectedRecord()));this.mgPlanPercent=10;this.mgPlanDays=7;
    this.mgPlanKey=crypto.randomUUID();this.mgPlanResult=null;this.mgPlanError='';this.mgPlanOpen=true;this.$nextTick(()=>this.$refs.mgPlanFocus?.focus());},
  mgPlanProposed(){return Math.round((this.mgPlanCampaign?.meta?.daily_budget||0)*(1+Number(this.mgPlanPercent)/100)*100)/100;},
  mgPlanExtra(){return Math.round((this.mgPlanProposed()-(this.mgPlanCampaign?.meta?.daily_budget||0))*Number(this.mgPlanDays)*100)/100;},
  async mgSavePlan(){
    if(this.mgBusy||this.mgPlanResult||!this.mgPlanCampaign)return;this.mgBusy=true;this.mgPlanError='';
    try{
      if(this.marketingIsMock()){this.mgPlanError='Prévia ilustrativa: este plano não é gravado.';return;}
      this.mgPlanResult=await this.apiPost(`/admin/api/marketing/geography/${this.mgPlanCampaign.id}/plans`,{
        period:this.marketingPeriod,target:Number(this.mgTarget),region:this.mgPlanCampaign.region,
        percent:Number(this.mgPlanPercent),days:Number(this.mgPlanDays),request_key:this.mgPlanKey});
    }catch{this.mgPlanError='Não foi possível salvar. Atualize os dados: a recomendação ou o orçamento pode ter mudado.';}
    finally{this.mgBusy=false;}
  },
  mgDownloadPlan(){if(!this.mgPlanResult)return;
    const p=this.mgPlanResult.payload;const text=`PLANO DE TESTE — RASCUNHO\nCampanha: ${p.campaign}\nRegião: ${p.region}\nOrçamento: ${this.mgMoney(p.before)} → ${this.mgMoney(p.proposed)} / dia\nPrazo: ${p.days} dias\nMeta por venda: ${this.mgMoney(p.target)}\nRevisar custo, margem e estoque.\nNenhuma alteração foi enviada à Meta.\nPlano: ${this.mgPlanResult.id}\n`;
    const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='plano-de-teste-marketing.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  },
};};
