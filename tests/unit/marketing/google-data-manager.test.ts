import {generateKeyPairSync} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {googleDataManager,GoogleIngestAmbiguous,type GooglePurchaseEvent} from '../../../src/marketing/google-data-manager.js';
const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
const config={accountId:'1234567890',actionId:'987',serviceAccountJson:JSON.stringify({type:'service_account',
  client_email:'test@test-project.iam.gserviceaccount.com',private_key_id:'a'.repeat(40),
  private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()})};
const event:GooglePurchaseEvent={transactionId:'farejador:test:11111111-1111-1111-1111-111111111111',
  eventTimestamp:'2026-10-01T12:00:00Z',conversionValue:99,currency:'BRL',conversionCount:1,eventSource:'MESSAGE',
  adIdentifiers:{gclid:'click_ref'},consent:{adUserData:'CONSENT_GRANTED',adPersonalization:'CONSENT_DENIED'}};
describe('Data Manager — recebimento nao equivale a confirmacao',()=>{
  it('valida sem executar e aceita resposta vazia, indicando conta de acesso direta',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:'secret'})).mockResolvedValueOnce(new Response(null,{status:200}));
    const transport=await googleDataManager(config,fetcher);
    expect(await transport.ingest(event,true)).toBe('');
    const body=JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.validateOnly).toBe(true);
    expect(body.destinations[0].loginAccount.accountId).toBe(config.accountId);
  });
  it('usa escopo proprio, sem PII, e consulta a confirmacao da acao correta',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:'secret-access'}))
      .mockResolvedValueOnce(Response.json({requestId:'r'}))
      .mockResolvedValueOnce(Response.json({requestStatusPerDestination:[{destination:{operatingAccount:{accountId:config.accountId},productDestinationId:config.actionId},requestStatus:'SUCCESS'}]}));
    const transport=await googleDataManager(config,fetcher);
    const assertion=(fetcher.mock.calls[0][1].body as URLSearchParams).get('assertion')!;
    expect(JSON.parse(Buffer.from(assertion.split('.')[1]!,'base64url').toString()).scope).toBe('https://www.googleapis.com/auth/datamanager');
    expect(await transport.ingest(event)).toBe('r');expect(await transport.status('r')).toBe('sent');
    const body=JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.events).toEqual([{...event,destinationReferences:['purchase']}]);expect(body.events[0]).not.toHaveProperty('userData');
    expect(fetcher.mock.calls[2][0]).toBe('https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=r');
  });
  it('timeout, 5xx e resposta sem requestId impedem reenvio automatico',async()=>{
    for(const result of [new Error('timeout'),Response.json({}, {status:500}),Response.json({})]){
      const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:'secret'}));
      if(result instanceof Error)fetcher.mockRejectedValueOnce(result);else fetcher.mockResolvedValueOnce(result);
      const transport=await googleDataManager(config,fetcher);
      await expect(transport.ingest(event)).rejects.toBeInstanceOf(GoogleIngestAmbiguous);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it('recusa dados invalidos antes de enviar e nunca confirma outra conta',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:'secret'}))
      .mockResolvedValueOnce(Response.json({requestStatusPerDestination:[{destination:{operatingAccount:{accountId:'9999999999'},productDestinationId:config.actionId},requestStatus:'SUCCESS'}]}));
    const transport=await googleDataManager(config,fetcher);
    await expect(transport.ingest({...event,conversionValue:NaN})).rejects.toThrow('invalid_conversion');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(transport.status('r')).rejects.toThrow('data_manager_status_unavailable');
  });
});
