/**
 * 字节流 → 字符串解码（前后端共用）
 *
 * 顺序：BOM 探测（UTF-16LE / UTF-16BE）→ UTF-8 严格 → GBK → UTF-8 兜底（非法字节替换）。
 *
 * 为什么必须处理 UTF-16：
 * Excel「另存为 → 文本文件（Unicode）」与记事本另存为 UTF-16 都会产出 UTF-16LE + BOM。
 * 只试 utf-8/gbk 时，UTF-16 字节流会走 GBK 兜底 —— 中文环境下一整份文件解成乱码，
 * 列头全部失配，导入直接失败。
 *
 * UTF-8 的 BOM（EF BB BF）不需要单独分支：TextDecoder 的 ignoreBOM 默认为 false，
 * 解码时会把 BOM 一并剔除。调用方各自的 `stripBOM()` 作为兜底保留（处理非本函数来源的字符串）。
 */
export function decodeBytes(bytes: Uint8Array): string {
  // UTF-16 BOM：FF FE = LE，FE FF = BE
  // TextDecoder('utf-16le'|'utf-16be') 的 ignoreBOM 默认为 false，会把 BOM 从结果中剔除
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { /* 非法 UTF-8 序列 → 试 GBK */ }
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    // 最后兜底：宽容 UTF-8（非法字节变 U+FFFD），保证调用方总能拿到字符串
    return new TextDecoder('utf-8').decode(bytes);
  }
}
