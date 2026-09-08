/**
 * 共享类型：前后端数据契约的唯一真源
 * 对应技术方案 §4.4 / §5.2
 */

/** 长表一行：(时间, 实体, 数值) */
export interface TimeSeriesRow {
  time_key: string;
  entity: string;
  value: number;
}

/** 时序数据取回形态（已按 time_order 排序） */
export interface SeriesPoint {
  time_key: string;
  time_order: number;
  entity: string;
  value: number;
}

/** 数据集元信息 */
export interface DatasetSummary {
  rowCount: number;
  timeCount: number;
  entityCount: number;
  timeMin: string | null;
  timeMax: string | null;
  missingValues: number;
}

/** 渲染配置（存 projects.config 的 JSON 结构） */
export interface RenderConfig {
  title: string;
  subtitle: string;
  sourceNote: string;
  /** 只显示前 N 名 */
  maxBars: number;
  /** 每个时间点的播放秒数 */
  secondsPerStep: number;
  /** 头尾定格秒数 */
  headHold: number;
  tailHold: number;
  /** 配色方案 id */
  palette: string;
  /** 是否显示条形末端数值 */
  showValues: boolean;
  /** 数值保留小数位 */
  valueDecimals: number;
  /** 是否显示排名序号 */
  showRank: boolean;
  /** 时间标签位置 */
  timeLabelPos: 'top-left' | 'top-right' | 'none';
  /** 时间标签模式：step=当前步标签；continuous=数值插值（仅全部时间点为数值时生效） */
  timeLabelMode: 'step' | 'continuous';
  /** 字号档（相对 1080p 基准的缩放） */
  fontScale: number;
  /** 背景色 */
  background: string;
  /** 导出分辨率 */
  width: number;
  height: number;
  fps: number;
  /** 码率 bps */
  videoBitsPerSecond: number;
}

export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  title: '条形图竞赛',
  subtitle: '',
  sourceNote: '数据来源：示例数据',
  maxBars: 15,
  secondsPerStep: 1.0,
  headHold: 0.5,
  tailHold: 0.5,
  palette: 'flat',
  showValues: true,
  valueDecimals: 0,
  showRank: true,
  timeLabelPos: 'top-right',
  timeLabelMode: 'step',
  fontScale: 1,
  background: '#f5f6fa',
  width: 1920,
  height: 1080,
  fps: 30,
  videoBitsPerSecond: 8_000_000,
};

/** 项目（列表/详情） */
export interface ProjectInfo {
  id: number;
  title: string;
  description: string | null;
  config: RenderConfig;
  dataset_hash: string | null;
  hasData: boolean;
  recordCount: number;
  created_at: string;
  updated_at: string;
}

/** 作品记录 */
export interface RecordInfo {
  id: number;
  project_id: number;
  project_title?: string;
  config_snapshot: RenderConfig;
  file_path: string | null;
  format: string;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  size_bytes: number;
  created_at: string;
}

/** 政府公开数据源备忘 */
export interface DatasourceInfo {
  id: string;
  name: string;
  url: string;
  note: string;
}

/** 统一响应 */
export interface ApiOk<T> { data: T }
export interface ApiErr { error: { code: string; message: string } }

export const ERROR_CODES = {
  CSV_PARSE: 'E_CSV_PARSE',
  EMPTY_TIMESERIES: 'E_EMPTY_TIMESERIES',
  NOT_FOUND: 'E_NOT_FOUND',
  VALIDATION: 'E_VALIDATION',
  INTERNAL: 'E_INTERNAL',
} as const;
