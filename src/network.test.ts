import {describe, expect, it} from 'vitest';
import {networkOptions, networkSummary} from './network';
describe('监听参数与反馈', () => {
    it('多个关键词共同匹配，默认一条，保留 fit_count 语义', () => {
        expect(networkOptions(' api/user\r\napi/order\napi/user\n', false, '1', '', true, 'ALL')).toEqual({targets:['api/user','api/order'],count:1,timeout:null,fitCount:true,method:'ALL'});
        expect(networkOptions('api/user', false, '3', '5', false, 'POST')).toMatchObject({count:3,timeout:5,fitCount:false,method:'POST'});
    });
    it('持续模式不受隐藏的 count 和 timeout 影响', () => {
        expect(networkOptions('api/user', true, 'bad', '-1', true, 'ALL')).toMatchObject({count:null,timeout:null});
    });
    it('拒绝空条件和无效数量或超时', () => {
        for (const count of ['0','1.5','bad','4294967296']) expect(() => networkOptions('api/user',false,count,'',true,'ALL')).toThrow();
        for (const timeout of ['0','-1','bad']) expect(() => networkOptions('api/user',false,'1',timeout,true,'ALL')).toThrow();
        expect(() => networkOptions(' \n',false,'1','',true,'ALL')).toThrow();
    });
    it('区分严格超时、接受部分和没有命中，避免误报 URL 无效', () => {
        expect(networkSummary({reason:'timeout',total:2,accepted:false},3)).toContain('未满足条数要求');
        expect(networkSummary({reason:'timeout',total:2,accepted:true},3)).toContain('接受部分结果');
        expect(networkSummary({reason:'timeout',total:0,accepted:false},1)).toContain('未捕获到符合条件');
        expect(networkSummary({reason:'complete',total:1,accepted:true},1)).toContain('自动结束');
    });
});
