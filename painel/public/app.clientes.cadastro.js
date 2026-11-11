window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.clientesCadastro = function () {
  const empty = () => ({name:'',commercial_profile:'nao_classificado',phone:'',email:'',document_number:'',
    postal_code:'',street:'',number:'',complement:'',neighborhood:'',city:'',state:''});
  let focusBefore = null;
  return {
    customerRegistryEnabled:false,clienteCadastroAberto:false,clienteCadastroBusy:false,clienteCadastroErro:'',
    clienteCadastroCampos:{},clienteCadastroForm:empty(),clienteCadastroFonte:null,clienteCadastroVersion:0,
    clienteCadastroKey:'',clientesPerfil:'todos',
    clientePerfil(c) {
      if (c?.commercial_profile) return c.commercial_profile;
      if (c?.source === 'atacado' || c?.kind === 'borracharia') return 'atacado';
      return c?.kind === 'pessoa_fisica' ? 'varejo' : 'nao_classificado';
    },
    clientePerfilLabel(c) { return ({varejo:'Varejo',atacado:'Atacado',nao_classificado:'Definir perfil'})[this.clientePerfil(c)]; },
    clientesPerfilResumo() {
      const rows = this.clientes;
      return {total:rows.length,varejo:rows.filter(c => this.clientePerfil(c)==='varejo').length,
        atacado:rows.filter(c => this.clientePerfil(c)==='atacado').length,
        nao_classificado:rows.filter(c => this.clientePerfil(c)==='nao_classificado').length};
    },
    clientesDefinirPerfil(perfil) { this.clientesPerfil=perfil; this.clientesPagina=1; },
    clienteTelefone(value) { return window.CustomerFields.phone(value); },
    clienteTelefoneRevisar(value) { return !!value && !window.CustomerFields.nationalPhone(value); },
    clienteCadastroMask(field) {
      const f = window.CustomerFields;
      const mask = {phone:f.phoneMask,document_number:f.documentMask,postal_code:f.postalMask}[field];
      this.clienteCadastroForm[field] = mask ? mask(this.clienteCadastroForm[field]) : this.clienteCadastroForm[field];
    },
    async abrirCadastroCliente(c = null) {
      if (!this.customerRegistryEnabled || this.clienteCadastroBusy) return;
      focusBefore = document.activeElement;
      this.clienteCadastroErro=''; this.clienteCadastroCampos={}; this.clienteCadastroFonte=null;
      this.clienteCadastroForm=empty(); this.clienteCadastroVersion=0; this.clienteCadastroKey=crypto.randomUUID();
      this.clienteCadastroAberto=true;
      this.$nextTick(() => { document.getElementById('cliente-cadastro-nome')?.focus(); lucide.createIcons(); });
      if (!c) return;
      this.clienteCadastroBusy=true;
      try {
        const data = await this.apiGet(`/admin/api/clientes/${c.source}/${c.source_id}/ficha?limit=1`);
        if (!this.clienteCadastroAberto) return;
        const entry = data.customer.registry;
        this.clienteCadastroFonte={source:c.source,source_id:c.source_id};
        this.clienteCadastroVersion=entry?.version || 0;
        const source = entry || {...data.customer,commercial_profile:this.clientePerfil(c)};
        this.clienteCadastroForm=Object.fromEntries(Object.keys(empty()).map(key=>[key,source[key] ?? empty()[key]]));
        for (const field of ['phone','document_number','postal_code']) this.clienteCadastroMask(field);
      } catch { this.clienteCadastroErro='Não foi possível carregar o cadastro. Feche e tente novamente.'; }
      finally { this.clienteCadastroBusy=false; }
    },
    fecharCadastroCliente() {
      if (this.clienteCadastroBusy) return;
      this.clienteCadastroAberto=false;
      const target=focusBefore; focusBefore=null;
      this.$nextTick(()=> { if (target?.isConnected) target.focus(); });
    },
    async salvarCadastroCliente() {
      if (this.clienteCadastroBusy || !this.customerRegistryEnabled || this.clienteCadastroErro.startsWith('Não foi possível carregar')) return;
      this.clienteCadastroBusy=true; this.clienteCadastroErro=''; this.clienteCadastroCampos={};
      const source=this.clienteCadastroFonte;
      const body={...this.clienteCadastroForm,...(source ? {expected_version:this.clienteCadastroVersion} : {idempotency_key:this.clienteCadastroKey})};
      try {
        const response=await fetch(source ? `/admin/api/clientes/${source.source}/${source.source_id}/cadastro` : '/admin/api/clientes/cadastro',
          {method:source?'PUT':'POST',headers:{...this.apiHeaders(),'Content-Type':'application/json'},body:JSON.stringify(body)});
        const data=await response.json();
        if (!response.ok) {
          this.clienteCadastroCampos=data.fields || {};
          throw new Error(({registry_version_conflict:'Este cadastro mudou. Feche e abra novamente antes de salvar.',
            customer_phone_exists:'Já existe um cliente com este telefone. Localize o cadastro antes de criar outro.',
            invalid_customer:'Confira os campos destacados.',customer_registry_unavailable:'Cadastro indisponível. Tente novamente.'})[data.error] || 'Não foi possível salvar.');
        }
        this.clienteCadastroAberto=false;
        await this.loadClientes(true);
        if (source && this.clienteFichaAberta && this.clienteFichaOrigem?.source_id===source.source_id
          && this.clienteFichaOrigem?.source===source.source) await this.carregarFichaCliente();
        if (focusBefore?.isConnected) focusBefore.focus(); focusBefore=null;
      } catch(error) { this.clienteCadastroErro=error.message || 'Não foi possível salvar.'; }
      finally { this.clienteCadastroBusy=false; }
    },
  };
};
