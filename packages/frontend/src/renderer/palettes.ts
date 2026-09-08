/**
 * 内置配色方案（方案 §3.6）：3 套
 * 实体 → 颜色：按首次出现顺序分配（同一实体全程颜色不变）
 */

export interface Palette {
  id: string;
  name: string;
  background: string;
  text: string;
  subText: string;
  grid: string;
  timeLabel: string;
  bars: string[];
  onBar: string; // 条内文本颜色
}

export const PALETTES: Palette[] = [
  {
    id: 'flat',
    name: '扁平亮色',
    background: '#f5f6fa',
    text: '#2d3436',
    subText: '#636e72',
    grid: '#dfe6e9',
    timeLabel: 'rgba(45, 52, 54, 0.16)',
    bars: [
      '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
      '#1abc9c', '#e67e22', '#34495e', '#e84393', '#00b894',
      '#0984e3', '#fdcb6e', '#6c5ce7', '#d63031', '#55efc4',
      '#74b9ff', '#ff7675', '#a29bfe',
    ],
    onBar: '#ffffff',
  },
  {
    id: 'journal',
    name: '期刊风',
    background: '#faf9f6',
    text: '#1a1a1a',
    subText: '#5a5a5a',
    grid: '#e3e0d8',
    timeLabel: 'rgba(26, 26, 26, 0.12)',
    bars: [
      '#276fbf', '#c0392b', '#16897d', '#8e44ad', '#b96a2b',
      '#4a6fa5', '#2f7d51', '#a63d57', '#5b7c99', '#94582c',
      '#3d5a80', '#7a5980', '#6b8f71', '#c17c74', '#50617a',
      '#8c7a5b', '#46794e', '#74557e',
    ],
    onBar: '#ffffff',
  },
  {
    id: 'dark',
    name: '高对比深色',
    background: '#101418',
    text: '#f2f5f7',
    subText: '#93a1ad',
    grid: '#232a32',
    timeLabel: 'rgba(242, 245, 247, 0.14)',
    bars: [
      '#ff5d5d', '#4dc9ff', '#3ddc97', '#ffc65d', '#b388ff',
      '#5dd0ff', '#ff9e64', '#7bd88f', '#f28fb0', '#62d2ff',
      '#ffe07d', '#8affc1', '#ff7ba9', '#9f8fff', '#63e6be',
      '#ffd166', '#74c0fc', '#f78fb3',
    ],
    onBar: '#101418',
  },
];

export function getPalette(id: string): Palette {
  return PALETTES.find(p => p.id === id) ?? PALETTES[0];
}

/** 稳定配色函数：按实体首次出现顺序取色（周期复用） */
export function makeColorOf(entities: string[], palette: Palette): (entity: string) => string {
  const idx = new Map<string, number>();
  entities.forEach((e, i) => idx.set(e, i));
  return (entity: string) => {
    const i = idx.get(entity) ?? 0;
    return palette.bars[i % palette.bars.length];
  };
}
