window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botEntrega = function () {
  const empty = { delivery_enabled:true,pickup_enabled:true,radius_km:null,address:'',latitude:0,longitude:0,days:[],opens_at:null,closes_at:null,delivery_days:null };
  const copy = value => JSON.parse(JSON.stringify(value));
  return {
    botEntregaForm:copy(empty),botEntregaConfig:null,botEntregaOriginal:'',botEntregaBusy:false,
    botEntregaErro:'',botEntregaMensagem:'',botEntregaAddress:'',botEntregaItems:[],botEntregaBusca:'',
    botEntregaProdutos:[],botEntregaBuscando:false,botEntregaResult:null,botEntregaSnapshot:'',
    botEntregaOrigemEditando:false,botEntregaOrigemTexto:'',botEntregaLocalizando:false,
    botEntregaDias:[{id:1,label:'Seg'},{id:2,label:'Ter'},{id:3,label:'Qua'},{id:4,label:'Qui'},{id:5,label:'Sex'},{id:6,label:'Sáb'},{id:0,label:'Dom'}],
    get botEntregaDirty(){return JSON.stringify(this.botEntregaForm)!==this.botEntregaOriginal;},
    get botEntregaStale(){return !!this.botEntregaResult && this.botEntregaFingerprint()!==this.botEntregaSnapshot;},
    botEntregaFingerprint(){return JSON.stringify([this.botEntregaForm,this.botEntregaAddress,this.botEntregaItems]);},
    async botEntregaAbrir(){
      this.botTab='entrega';
      if(!this.botEntregaConfig) await this.botEntregaCarregar();
      else this.$nextTick(()=>this.botEntregaMapaAtualizar());
    },
    async botEntregaCarregar(){
      if(this.botEntregaBusy)return;
      this.botEntregaBusy=true;this.botEntregaErro='';this.botEntregaMensagem='';
      try{
        this.botEntregaConfig=await this.apiGet('/admin/api/bot/entrega');
        this.botEntregaForm=copy(this.botEntregaConfig.settings);
        this.botEntregaOriginal=JSON.stringify(this.botEntregaForm);
        this.botEntregaResult=null;
        this.$nextTick(()=>this.botEntregaMapaAtualizar());
      }catch(e){this.botEntregaErro=this.botEntregaError(e);}
      finally{this.botEntregaBusy=false;}
    },
    botEntregaError(e){
      const text=e?.message||'';
      if(text.includes('conflict'))return 'Outra pessoa salvou alterações. Recarregue o cadastro antes de salvar novamente.';
      if(text.includes('address_not_found'))return 'Não encontramos esse endereço. Inclua rua, número, cidade e estado.';
      if(text.includes('403')||text.includes('owner'))return 'Somente o proprietário pode configurar a entrega.';
      if(text.includes('invalid_'))return 'Confira o raio, os dias, os horários e os produtos informados.';
      return 'Não foi possível concluir. Tente novamente; suas alterações continuam na tela.';
    },
    botEntregaValidar(){
      const f=this.botEntregaForm;
      if(f.delivery_enabled&&(!Number.isFinite(Number(f.radius_km))||Number(f.radius_km)<=0||Number(f.radius_km)>40))return 'Informe um limite de entrega entre 0 e 40 km.';
      if((f.opens_at||f.closes_at)&&(!f.opens_at||!f.closes_at||f.opens_at>=f.closes_at))return 'Preencha um horário de início e fim válido.';
      if((f.opens_at||f.delivery_days!==null)&&!f.days.length)return 'Selecione os dias em que a Matriz entrega.';
      return '';
    },
    botEntregaPayload(){
      const f=copy(this.botEntregaForm);
      f.radius_km=f.radius_km===''?null:f.radius_km===null?null:Number(f.radius_km);
      f.delivery_days=f.delivery_days===''?null:f.delivery_days===null?null:Number(f.delivery_days);
      f.opens_at=f.opens_at||null;f.closes_at=f.closes_at||null;
      return f;
    },
    async botEntregaSalvar(){
      if(this.botEntregaBusy||!this.botEntregaConfig)return;
      this.botEntregaErro=this.botEntregaValidar();if(this.botEntregaErro)return;
      this.botEntregaBusy=true;this.botEntregaMensagem='';
      try{
        const result=await this.apiPut('/admin/api/bot/entrega',{settings:this.botEntregaPayload(),expected_version:this.botEntregaConfig.version});
        this.botEntregaConfig={...this.botEntregaConfig,...result};
        this.botEntregaForm=copy(result.settings);this.botEntregaOriginal=JSON.stringify(this.botEntregaForm);
        this.botEntregaMensagem='Configuração salva. O bot já usa estas regras nas próximas consultas e pedidos.';
      }catch(e){this.botEntregaErro=this.botEntregaError(e);}
      finally{this.botEntregaBusy=false;}
    },
    botEntregaDia(id){
      const f=this.botEntregaForm;f.days=f.days.includes(id)?f.days.filter(d=>d!==id):[...f.days,id];
    },
    async botEntregaLocalizar(){
      if(this.botEntregaLocalizando)return;
      this.botEntregaLocalizando=true;this.botEntregaErro='';
      try{
        const point=await this.apiPost('/admin/api/bot/entrega/localizar',{address:this.botEntregaOrigemTexto.trim()});
        if(!['ROOFTOP','RANGE_INTERPOLATED'].includes(point.confidence)){
          this.botEntregaErro='Endereço pouco preciso. Informe a rua e o número da Matriz.';return;
        }
        Object.assign(this.botEntregaForm,{address:this.botEntregaOrigemTexto.trim(),latitude:point.lat,longitude:point.lng});
        this.botEntregaOrigemEditando=false;this.botEntregaMapaAtualizar();
      }catch(e){this.botEntregaErro=this.botEntregaError(e);}
      finally{this.botEntregaLocalizando=false;}
    },
    async botEntregaBuscar(){
      const q=this.botEntregaBusca.trim();
      if(q.length<2){this.botEntregaProdutos=[];return;}
      this.botEntregaBuscando=true;
      try{
        const data=await this.apiGet('/admin/api/bot/entrega/produtos?q='+encodeURIComponent(q));
        if(q===this.botEntregaBusca.trim())this.botEntregaProdutos=data.products;
      }catch(e){this.botEntregaErro=this.botEntregaError(e);}
      finally{this.botEntregaBuscando=false;}
    },
    botEntregaAdicionar(p){
      const existing=this.botEntregaItems.find(i=>i.product_id===p.id);
      if(existing){existing.quantity=Math.min(50,existing.quantity+1);}
      else if(this.botEntregaItems.length<8)this.botEntregaItems.push({product_id:p.id,quantity:1,name:p.product_name});
      this.botEntregaProdutos=[];this.botEntregaBusca='';
    },
    async botEntregaSimular(){
      if(this.botEntregaBusy)return;
      this.botEntregaErro=this.botEntregaValidar();if(this.botEntregaErro)return;
      if(!this.botEntregaItems.length||this.botEntregaAddress.trim().length<5){this.botEntregaErro='Informe o endereço do cliente e adicione os pneus do pedido.';return;}
      this.botEntregaBusy=true;this.botEntregaMensagem='';
      const snapshot=this.botEntregaFingerprint();
      try{
        this.botEntregaResult=await this.apiPost('/admin/api/bot/entrega/simular',{address:this.botEntregaAddress.trim(),settings:this.botEntregaPayload(),
          items:this.botEntregaItems.map(i=>({product_id:i.product_id,quantity:Number(i.quantity)}))});
        this.botEntregaSnapshot=snapshot;this.$nextTick(()=>this.botEntregaMapaAtualizar());
      }catch(e){this.botEntregaResult=null;this.botEntregaErro=this.botEntregaError(e);}
      finally{this.botEntregaBusy=false;}
    },
    botEntregaMotivo(reason){return ({apt:'Pedido completo',insufficient_stock:'Estoque insuficiente',outside_radius:'Fora do limite',outside_ring:'Além da busca automática',
      radius_missing:'Sem raio cadastrado',needs_location:'Localização não confirmada',pickup_only:'Somente retirada',delivery_paused:'Entrega pausada',pickup_disabled:'Retirada desabilitada',
      only_far:'Só há opção distante; exige consulta ao cliente',unavailable:'Nenhuma loja apta',matriz_closer:'A Matriz está mais perto que os parceiros aptos do anel.',
      matriz_fallback:'A Matriz pode atender e não há parceiro apto no anel.',partner_fairness:'Parceiro escolhido pela distribuição atual entre as lojas aptas do anel mais próximo.'})[reason]||reason;},
    botEntregaKm(km){return km==null?'—':Number(km).toLocaleString('pt-BR',{maximumFractionDigits:1})+' km';},
  };
};
