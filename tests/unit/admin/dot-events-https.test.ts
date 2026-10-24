import { EventEmitter } from 'node:events';
import { beforeEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({lookup:vi.fn(),request:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:mocks.lookup}));
vi.mock('node:https',()=>({request:mocks.request}));
import { sendWebhook } from '../../../src/admin/dot/events/https.js';
beforeEach(()=>vi.resetAllMocks());
it('recusa resolução mista sem abrir socket',async()=>{
  mocks.lookup.mockResolvedValue([{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);
  await expect(sendWebhook('https://example.com/events','{}',{})).rejects.toThrow('invalid_callback');
  expect(mocks.request).not.toHaveBeenCalled();
});
it('fixa IP validado na conexão, mantém hostname TLS e não segue redirect',async()=>{
  mocks.lookup.mockResolvedValue([{address:'8.8.8.8',family:4}]);
  mocks.request.mockImplementation((url,options,callback)=>{
    expect(url.hostname).toBe('example.com');expect(options.agent).toBe(false);
    expect(options.autoSelectFamily).toBe(false);expect(options.family).toBe(4);
    const done=vi.fn();options.lookup('example.com',{},done);
    expect(done).toHaveBeenCalledWith(null,'8.8.8.8',4);
    const req=new EventEmitter() as EventEmitter&{end:()=>void;destroy:()=>void};
    req.destroy=()=>{};req.end=()=>{
      const res=Object.assign(new EventEmitter(),{statusCode:302,headers:{location:'https://127.0.0.1'}});
      callback(res);res.emit('end');req.emit('close');
    };return req;
  });
  expect((await sendWebhook('https://example.com/events','{}',{})).status).toBe(302);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  mocks.lookup.mockResolvedValue([{address:'127.0.0.1',family:4}]);
  await expect(sendWebhook('https://example.com/events','{}',{})).rejects.toThrow();
  expect(mocks.lookup).toHaveBeenCalledTimes(2);expect(mocks.request).toHaveBeenCalledTimes(1);
});
