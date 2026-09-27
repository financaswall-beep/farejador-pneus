// Prévia explícita ?mock=1; nunca consulta ou escreve no ambiente real.
function marketingOrganicMock() {
  const posts = [
    ['Pneus meia-vida: veja de perto','Qualidade em cada detalhe.','instagram','reel','tire-dashboard.webp'],
    ['Retire seu pneu na loja','Seu pneu pronto para retirada.','facebook','image','estoque-hero-warehouse.webp'],
    ['Como escolher a medida do pneu?','Confira a medida na lateral.','instagram','carousel','catalog-tire.webp'],
    ['Pneu de scooter','90/90-12','facebook','image','catalog-tire.webp'],
    ['Pneus para seu carro','175/65R14','instagram','image','catalog-tire-car.png'],
    ['Pneu para sua NMAX','Precisando de pneu 130/70-13 para sua NMAX?\nFala com a gente nos comentários.','instagram','image','catalog-tire.webp'],
  ];
  return {fetched_at:new Date().toISOString(),sources:['facebook','instagram'].map(platform => ({platform,status:'ready',truncated:false})),
    rows:posts.map(([title,caption,platform,format,asset],i) => ({id:String(i+1),platform,title,caption,format,
      published_at:new Date(Date.now()-(10+i)*86400000).toISOString(),image_url:'/admin/painel/assets/'+asset,url:null}))};
}
function marketingOrganicMockDetail(publication, window = '7d') {
  const since = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date(publication.published_at));
  const day = offset => {const d=new Date(since+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);};
  const sales = window === '30d' ? [1,1,2,3,4,6,8,8,9,9] : [1,1,2,3,4,6,8];
  return {publication,summary:{available:true,comments:{received:24,replied:18,pending:3,failed:1,deleted:2},
    series:[2,3,4,1,5,9].map((received,i) => ({received,date:new Date(Date.now()-(5-i)*86400000).toISOString().slice(0,10)}))},
    attribution:{status:'ready',period:{id:window,since,until:day(window==='30d'?29:6)},
      private_messages:48,conversations:30,converted_conversations:sales.at(-1),sales:sales.at(-1),revenue:sales.at(-1)*178,
      sales_series:sales.map((sales,i)=>({date:day(i),sales}))}};
}
