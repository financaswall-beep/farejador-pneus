import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
const mocks=vi.hoisted(()=>({query:vi.fn(),validate:vi.fn(),ingest:vi.fn(),status:vi.fn()}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{query:mocks.query}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',GOOGLE_ADS_CONVERSIONS_ENABLED:true,
  GOOGLE_ADS_CUSTOMER_ID:'1234567890',GOOGLE_ADS_CONVERSION_ACTION_ID:'987',GOOGLE_ADS_SERVICE_ACCOUNT_JSON:'test-only'}}));
vi.mock('../../../src/marketing/google-data-manager.js',async original=>({...await original<object>(),
  googleDataManager:async()=>({validateDestination:mocks.validate,ingest:mocks.ingest,status:mocks.status})}));
describe('Conversoes Google — validar destino antes de consumir a fila',()=>{
  beforeEach(()=>{vi.resetModules();vi.clearAllMocks();mocks.query.mockResolvedValue({rows:[],rowCount:0});});
  it('mantem a fila e tentativas intactas quando o destino nao esta disponivel',async()=>{
    mocks.validate.mockRejectedValue(new Error('destination_pending'));
    const {processGoogleConversions,googleConversionHealth}=await import('../../../src/marketing/google-conversions.js');
    expect(await processGoogleConversions({dbPool:{query:mocks.query} as unknown as Pool}))
      .toMatchObject({processed:0,destination_ready:false});
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('attempts=q.attempts+1'))).toBe(false);
    expect(mocks.ingest).not.toHaveBeenCalled();expect(mocks.status).not.toHaveBeenCalled();
    expect(googleConversionHealth().state).toBe('error');
  });
  it('volta a validar na proxima execucao e consulta a fila quando o Google libera o destino',async()=>{
    mocks.validate.mockRejectedValueOnce(new Error('pending')).mockResolvedValueOnce(undefined);
    const {processGoogleConversions,googleConversionHealth}=await import('../../../src/marketing/google-conversions.js');
    const dbPool={query:mocks.query} as unknown as Pool;
    await processGoogleConversions({dbPool});await processGoogleConversions({dbPool});
    expect(mocks.validate).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.filter(([sql])=>sql.includes('attempts=q.attempts+1'))).toHaveLength(1);
    expect(googleConversionHealth().state).toBe('ready');expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
