// Prévia explícita ?mock=1; nunca consulta ou escreve no ambiente real.
function marketingOrganicMock() {
  const posts = [
    ['Pneus meia-vida: veja de perto','Qualidade em cada detalhe.','instagram','reel','tire-dashboard.webp'],
    ['Retire seu pneu na loja','Seu pneu pronto para retirada.','facebook','image','estoque-hero-warehouse.webp'],
    ['Como escolher a medida do pneu?','Confira a medida na lateral.','instagram','carousel','catalog-tire.webp'],
    ['Pneu de scooter','90/90-12','facebook','image','catalog-tire.webp'],
    ['Pneus para seu carro','175/65R14','instagram','image','catalog-tire-car.png'],
    ['Pneu para sua NMAX','130/70-13','instagram','image','catalog-tire.webp'],
  ];
  return {fetched_at:new Date().toISOString(),sources:['facebook','instagram'].map(platform => ({platform,status:'ready',truncated:false})),
    rows:posts.map(([title,caption,platform,format,asset],i) => ({id:String(i+1),platform,title,caption,format,
      published_at:new Date(Date.now()-i*86400000).toISOString(),image_url:'/admin/painel/assets/'+asset,url:null}))};
}
function marketingOrganicMockDetail(publication) {
  return {publication,summary:{available:true,comments:{received:24,replied:18,pending:3,failed:1,deleted:2},
    series:[2,3,4,1,5,9].map((received,i) => ({received,date:new Date(Date.now()-(5-i)*86400000).toISOString().slice(0,10)}))},
    attribution:{status:'not_implemented',private_messages:null,conversations:null,sales:null,revenue:null}};
}
