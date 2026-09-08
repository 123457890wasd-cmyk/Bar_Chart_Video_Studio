import type { FastifyInstance } from 'fastify';
import type { DatasourceInfo } from '@barstudio/shared';

/**
 * 内置常用政府公开统计入口备忘（方案 §4.3）
 * 按实际视频主题逐步扩充；这里只做「入口备忘」，不预绑定具体机构数据格式。
 */
const DATASOURCES: DatasourceInfo[] = [
  {
    id: 'stats-gov',
    name: '国家统计局 · 国家数据',
    url: 'https://data.stats.gov.cn/',
    note: '年度/季度/月度分省与分行业指标，可导出 CSV（注意多为 GBK 编码，导入器已内置转码）',
  },
  {
    id: 'stats-gov-easyquery',
    name: '国家数据 · 便捷查询接口',
    url: 'https://data.stats.gov.cn/easyquery.htm',
    note: '按指标—地区—时间查询，导出后用本地上传导入',
  },
  {
    id: 'mca-name',
    name: '民政部 · 统计季报',
    url: 'https://www.mca.gov.cn/n156/n2679/index.html',
    note: '行政区划、社会组织等统计数据',
  },
  {
    id: 'govdata-general',
    name: '各部委数据开放平台汇总',
    url: 'https://www.gov.cn/xinwen/ztml/sjyk/',
    note: '按主题检索部委公开数据文件（Excel/CSV）',
  },
];

export async function datasourceRoutes(app: FastifyInstance) {
  app.get('/datasources', async () => ({ data: DATASOURCES }));
}
