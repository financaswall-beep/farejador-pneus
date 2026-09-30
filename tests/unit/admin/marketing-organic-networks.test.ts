import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {describe,it,expect,vi} from 'vitest';
function app(){
  const window:any={},context=createContext({window,Intl,Date,setTimeout,clearTimeout,lucide:{createIcons:vi.fn()}});
  runInContext(readFileSync('painel/public/app.marketing.organic.networks.js','utf8'),context);
  return Object.assign(window.PAINEL_MODULES.marketingOrganicNetworks(),{
    moData:{active_platforms:['instagram','facebook'],rows:[]},
    moSelected:{key:'publisher:one',deliveries:[{platform:'instagram',account_id:'200',post_id:'301',status:'published'},
      {platform:'facebook',account_id:'100',post_id:'302',status:'published'}]},
    $nextTick:(fn:()=>void)=>fn(),$refs:{},marketingIsMock:()=>false,
    apiGet:vi.fn(),moOpen:vi.fn(),moSummaryNumber:(v:any)=>v==null?'—':String(v),moNetworkLabel:(v:any)=>v,
  });
}
describe('Cards e histórico respeitam integrações ativas',()=>{
  it('TikTok/YouTube inativos não aparecem nem no gráfico, mesmo com dado antigo',()=>{
    const a=app();a.morMetrics={networks:['instagram','facebook','tiktok','youtube'].map(platform=>({platform})),history:[]};
    expect(a.morActivePlatforms()).toEqual(['instagram','facebook']);
    expect(a.morNetworkCards().map((n:any)=>n.platform)).toEqual(['instagram','facebook']);
    expect(a.morHistorySeries().map((n:any)=>n.platform)).toEqual(['instagram','facebook']);
  });
  it('permite quatro cards somente se o servidor declarar as quatro integrações ativas',()=>{
    const a=app();a.moData.active_platforms=['instagram','facebook','tiktok','youtube'];
    a.morMetrics={networks:a.moData.active_platforms.map((platform:string)=>({platform}))};
    expect(a.morNetworkCards()).toHaveLength(4);a.morNetwork='youtube';expect(a.morNetworkCards()).toHaveLength(1);
    a.moData.active_platforms=[];expect(a.morNetworkCards()).toHaveLength(0);
  });
  it('rejeita seleção de rede sem destino ativo e recarrega o relatório comercial autorizado',async()=>{
    const a=app();await a.morChooseNetwork('youtube');expect(a.moOpen).not.toHaveBeenCalled();
    await a.morChooseNetwork('facebook');expect(a.morNetwork).toBe('facebook');expect(a.moOpen).toHaveBeenCalledWith(a.moSelected,true);
  });
  it('não interpola lacunas nem inventa valores antes da primeira coleta',()=>{
    const a=app(),dates=a.morHistoryDates();
    a.morMetrics={history_ready:true,networks:[{platform:'instagram',account_id:'200',post_id:'301'}],
      history:[{platform:'instagram',account_id:'200',post_id:'301',date:dates[5],views:0}]};
    expect(a.morHistorySeries()[0].points).toEqual([null,null,null,null,null,0,null]);
    expect(a.morHistoryNotice()).toContain('Primeira coleta');
  });
  it('ignora retorno antigo depois de fechar ou selecionar outro conteúdo',async()=>{
    const a=app();let resolve!:(v:any)=>void;a.apiGet.mockReturnValue(new Promise(done=>resolve=done));
    const loading=a.morLoadMetrics();a.morClose();a.moSelected={key:'publisher:two'};
    resolve({networks:[],history:[]});await loading;
    expect(a.morMetrics).toBe(null);expect(a.moInsightsLoading).toBe(false);
  });
  it('mantém total parcial e zero reais, sem somar destinos não publicados',()=>{
    const a=app();a.moNetwork='all';const post={deliveries:[{platform:'instagram',status:'published',views:0},
      {platform:'facebook',status:'published',views:null}]};
    expect(a.morViews(post)).toEqual({value:0,partial:true});
    post.deliveries[1]!.status='uncertain';expect(a.morViews(post)).toEqual({value:0,partial:false});
  });
});
