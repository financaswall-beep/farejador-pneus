import {describe,it,expect,vi} from 'vitest';
import {loadGoogleAdDetails} from '../../../src/marketing/google-ads-details.js';
const config={environment:'test' as const,customerId:'1234567890',clientId:'c',clientSecret:'s',refreshToken:'r',
  apiVersion:'v25',scope:'campaigns' as const,campaignIds:['11']};
const base=(group='22')=>({campaign:{id:'11',name:'Pneus'},adGroup:{id:group},adGroupAd:{status:'PAUSED',ad:{id:'33',
  name:'Oferta',type:'RESPONSIVE_SEARCH_AD',finalUrls:['https://2w.example/'],responsiveSearchAd:{headlines:[{text:'Pneus de moto'}]}}}});
const day=(group='22',cost='1234555')=>({...base(group),segments:{date:'2026-10-01'},metrics:{costMicros:cost,impressions:'100',clicks:'4',conversions:1.5,conversionsValue:100}});
const window={since:'2026-09-25',until:'2026-10-01'};
describe('Google — anuncios individuais',()=>{
  it('separa mesmo ad id em grupos distintos, soma micros e inclui pausa sem entrega',async()=>{
    const search=vi.fn().mockResolvedValueOnce([base(),base('23'),base('24')]).mockResolvedValueOnce([day(),day('23')]);
    const ads=await loadGoogleAdDetails(search,config,window);
    expect(ads).toHaveLength(3);expect(ads.map(a=>a.id)).toEqual(['22:33','23:33','24:33']);
    expect(ads[0]).toMatchObject({investment:1.23,conversions:1.5,cpc:0.31,cpm:12.35,ctr:4});
    expect(ads[2]).toMatchObject({investment:0,cpc:null,status:'PAUSED'});
    expect(search.mock.calls[1][0]).toContain('campaign.id IN (11)');
  });
  it('recusa campanha fora do escopo, data fora da janela e linha duplicada',async()=>{
    for(const rows of [[{...day(),campaign:{id:'99'}}],[{...day(),segments:{date:'2020-01-01'}}],[day(),day()]]){
      const search=vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
      await expect(loadGoogleAdDetails(search,config,window)).rejects.toThrow('invalid_response');
    }
  });
  it('nunca oferece destino javascript ou credencial embutida',async()=>{
    const row=base();row.adGroupAd.ad.finalUrls=['javascript:alert(1)'];
    const search=vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    expect((await loadGoogleAdDetails(search,config,window))[0]?.final_url).toBeNull();
  });
});
