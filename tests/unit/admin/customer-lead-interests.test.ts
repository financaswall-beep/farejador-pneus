import { describe, expect, it } from 'vitest';
import { buildLeadInterests, type LeadInterestTurn } from '../../../src/admin/painel/customer-lead-interests.js';

const product = (id='p110', size='110/70-13', price:unknown='89.00', cond='meia_vida') => ({
  product_id:id,product_name:`Pneu ${size}`,tire_size:size,tire_condition:cond,brand:'IRA',price_amount:price,
  currency:'BRL',total_stock_available:7,
});
const call = (id:string,args:unknown,result:unknown) => [
  {role:'assistant',tool_calls:[{id,function:{name:'buscar_produto',arguments:JSON.stringify(args)}}]},
  {role:'tool',tool_call_id:id,content:JSON.stringify(result)},
];
const turn = (actions:unknown, id='msg'):LeadInterestTurn => ({actions,trigger_message_id:id,created_at:'2026-09-12T14:48:00Z'});
const fact = (value:unknown) => ({fact_value:value});
const missing = {encontrado:false,mensagem:'Nenhum produto com estoque encontrado.'};
const search = {trigger_message_id:'msg',measure:'130/70-13',filters:{},stores:[{id:'matriz',name:'Matriz',available:false}]};

describe('interesses do lead por medida e cotação do próprio produto', () => {
  it('mantém os dois pneus, deduplica a reconsulta e nunca atribui os R$ 89 do 110 ao 130', () => {
    const actions = [...call('a',{medida_pneu:'130/70-13'},missing),
      ...call('b',{medida_pneu:'110/70-13'},{encontrado:true,produtos:[product()]}),
      ...call('c',{medida_pneu:'130/70-13'},missing)];
    const items = buildLeadInterests([fact('130/70-13'),fact('130 70 13'),fact('110/70-13')],[turn(actions)],[search]);
    expect(items.map(i => i.measure)).toEqual(['130/70-13','110/70-13']);
    expect(items[0].variants).toHaveLength(1);
    expect(items[0].variants[0]).toMatchObject({quotes:[],availability:'unavailable',stores:search.stores});
    expect(items[1].variants[0]).toMatchObject({condition:'meia_vida',quotes:[{product_id:'p110',amount:89}]});
  });
  it('consulta de novo sem cadastro preserva o preço exclusivo do meia-vida', () => {
    const items = buildLeadInterests([], [turn([
      ...call('a',{medida_pneu:'110/70-13'},{encontrado:true,produtos:[product()]}),
      ...call('b',{medida_pneu:'110/70-13',condicao_pneu:'novo'}, {encontrado:false,mensagem:'Nenhum produto encontrado.'}),
    ])], []);
    expect(items).toHaveLength(1);
    expect(items[0].variants).toHaveLength(2);
    expect(items[0].variants[0].quotes[0].amount).toBe(89);
    expect(items[0].variants[1]).toMatchObject({condition:'novo',availability:'not_found',quotes:[]});
  });
  it('uma reconsulta sem estoque retira a cotação anterior do mesmo escopo', () => {
    const items = buildLeadInterests([], [turn(call('a',{medida_pneu:'130/70-13'},
      {encontrado:true,produtos:[product('p130','130/70-13')]}),'older'),
      turn(call('b',{medida_pneu:'130/70-13'},missing))], [search]);
    expect(items[0].variants).toHaveLength(1);
    expect(items[0].variants[0]).toMatchObject({quotes:[],availability:'unavailable'});
  });
  it('preços e condições de produtos diferentes ficam separados mesmo no mesmo resultado', () => {
    const items = buildLeadInterests([], [turn(call('a',{}, {encontrado:true,produtos:[
      product('a','110/70-13','89'),product('b','110/70-13','190','novo'),product('c','130/70-13','250','novo'),
    ]}))], []);
    expect(items.map(i=>i.variants.map(v=>v.quotes.map(q=>q.amount)))).toEqual([[[89],[190]],[[250]]]);
  });
  it('não reaproveita preços sem vínculo, conteúdo malformado, moeda estrangeira ou falta de localização', () => {
    const items = buildLeadInterests([fact('130/70-13'),fact('89'),fact({medida:'não é string'})], [turn([
      ...call('a',{medida_pneu:'130/70-13'},{encontrado:true,precisa_localizacao:true,produtos:[product('a','130/70-13')]}),
      ...call('b',{medida_pneu:'110/70-13'},{encontrado:true,produtos:[product('b','110/70-13',null),
        {...product('c'),currency:'USD'},product('d','110/70-13','errado')]}),
      {role:'assistant',tool_calls:[{id:'bad',function:{name:'buscar_produto',arguments:'{'}}]},
      {role:'tool',tool_call_id:'bad',content:'{'},
    ])], []);
    expect(items).toHaveLength(2);
    expect(items.flatMap(i=>i.variants.flatMap(v=>v.quotes))).toEqual([]);
    expect(items[0].variants).toEqual([]);
  });
  it('aceita aro em polegadas e não duplica notações radiais', () => {
    expect(buildLeadInterests([fact('140/70R17'),fact('140/70-17'),fact('2.75-18')],[],[]).map(i=>i.measure))
      .toEqual(['140/70-17','2.75-18']);
  });
  it('não mistura o estoque de outra consulta ou condição', () => {
    const items = buildLeadInterests([], [turn(call('a',{medida_pneu:'130/70-13'},missing))],
      [{...search,trigger_message_id:'outra'}, {...search,filters:{condicao_pneu:'novo'}}]);
    expect(items[0].variants[0]).toMatchObject({availability:'unknown',stores:[],quotes:[]});
  });
  it('recupera cotações por compatibilidade e também a medida sem produto na busca interna', () => {
    const actions=call('a',{moto_modelo:'NMAX'},{encontrado:true,veiculos:[{produtos:[{
      product_id:'p110',tire_size:'110/70-13',tire_condition:'novo',current_price:'199',total_stock:2,
    }]}]});
    actions[0].tool_calls![0].function.name='buscar_compatibilidade';
    expect(buildLeadInterests([],[turn(actions)],[])[0].variants[0].quotes[0].amount).toBe(199);
    const nested=call('b',{moto_modelo:'NMAX'},{consultas_estoque:[
      {medida_pneu:'130/70-13',resultado:missing},
      {medida_pneu:'110/70-13',resultado:{encontrado:true,produtos:[product()]}},
    ]});
    nested[0].tool_calls![0].function.name='buscar_compatibilidade';
    const items=buildLeadInterests([],[turn(nested)],[search]);
    expect(items).toHaveLength(2);
    expect(items[0].variants[0]).toMatchObject({availability:'unavailable',quotes:[]});
    expect(items[1].variants[0].quotes[0].amount).toBe(89);
  });
  it('estoque desconhecido e valor booleano não viram falta nem preço zero', () => {
    const items=buildLeadInterests([],[turn(call('a',{}, {encontrado:true,produtos:[
      {...product(),total_stock_available:null},product('p130','130/70-13',false),
    ]}))],[]);
    expect(items[0].variants[0]).toMatchObject({availability:'unknown',quotes:[]});
    expect(items[1].variants[0].quotes).toEqual([]);
  });
});
