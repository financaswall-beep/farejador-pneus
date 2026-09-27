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
  const car=publication.title.includes('carro');
  const sales=car?[0,1,1,2,3,4,5]:[1,1,2,3,4,6,8];
  const conversations=car?[2,4,7,10,14,17,20]:[3,7,12,16,21,25,30];
  if(window==='30d'){sales.push(...(car?[5,6,6]:[8,9,9]));conversations.push(...(car?[21,22,22]:[31,32,33]));}
  const total=sales.at(-1), names=['Bruno S.','Marina C.','Lucas S.','Ana L.','Pedro M.','Carla S.','Rafael A.','Júlia R.','José L.'];
  const durations=[20,40,180,640,720,780,1200,1800,900].slice(0,total), ordered=[...durations].sort((a,b)=>a-b);
  const median=total%2?ordered[Math.floor(total/2)]:(ordered[total/2-1]+ordered[total/2])/2;
  const rows=names.slice(0,total).map((customer_name,i)=>{
    const completed_at=day([0,2,3,4,5,5,6,6,7][i])+'T18:00:00.000Z', reply=Date.parse(completed_at)-durations[i]*60000;
    return {order_id:'mock-'+publication.id+'-'+i,order_number:[1042,1045,1048,1051,1053,1054,1058,1061,1063][i],customer_name,
      completed_at,amount:car?299:178,status:'completed',source_confirmed:true,
      origin:{comment_text:i?'Quero saber mais sobre esse pneu.':'Tem esse pneu? Como faço para comprar?',commented_at:new Date(reply-900000).toISOString(),
        private_sent_at:new Date(reply-600000).toISOString(),first_reply_at:new Date(reply).toISOString(),conversation_id:'ilustrativa-'+(101+i),comment_url:null}};
  });
  rows.push({...rows[0],order_id:'mock-'+publication.id+'-cancelled',order_number:1070,customer_name:'Felipe T.',status:'cancelled',completed_at:null,cancelled_at:day(6)+'T19:00:00.000Z'});
  return {publication,summary:{available:true,comments:{received:24,replied:18,pending:3,failed:1,deleted:2},
    series:[2,3,4,1,5,9].map((received,i) => ({received,date:new Date(Date.now()-(5-i)*86400000).toISOString().slice(0,10)}))},
    attribution:{status:'ready',period:{id:window,since,until:day(window==='30d'?29:6)},
      private_messages:car?38:48,conversations:conversations.at(-1),converted_conversations:sales.at(-1),sales:sales.at(-1),revenue:sales.at(-1)*(car?299:178),
      sales_series:sales.map((sales,i)=>({date:day(i),sales})),
      conversation_series:conversations.map((conversations,i)=>({date:day(i),conversations})),
      sales_rows:rows,sales_rows_complete:true,private_replied:conversations.at(-1),private_failed:2,
      median_sale_minutes:median,sale_time_buckets:[durations.filter(m=>m<=60).length,durations.filter(m=>m>60&&m<=720).length,durations.filter(m=>m>720&&m<=1440).length,durations.filter(m=>m>1440).length],
      private_failures:[{id:'demo-1',occurred_at:day(1)+'T14:10:00Z',message:'O envio não foi aceito pelo canal.'},{id:'demo-2',occurred_at:day(3)+'T16:20:00Z',message:'Não foi possível confirmar a entrega da mensagem.'}]}};
}
