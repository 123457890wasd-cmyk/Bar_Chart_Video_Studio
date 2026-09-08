/**
 * 录制导出链路（技术方案 §3.5 / §6.3 实现必读）
 *
 * 1. 隐藏高清画布（默认 1920×1080，不挂 DOM）
 * 2. canvas.captureStream(0) + track.requestFrame() 手动推帧（帧率精确、不受高刷屏影响）
 *    —— 不支持 requestFrame 时降级 captureStream(fps)
 * 3. MediaRecorder mimeType 探测降级链：
 *    mp4(avc1) 直录 → webm(vp9) → webm(vp8) → webm
 * 4. 墙钟时间驱动渲染进度（暂停/恢复不跳帧，变速不丢时间）
 * 5. webm 产物用 ffmpeg.wasm 就地转 H.264 mp4（yuv420p + faststart）；
 *    ffmpeg 加载/转码失败时降级交付 webm
 * 6. 时间基准 setTimeout 按目标帧时刻自校正，避免累计漂移
 */
import type { RenderConfig } from '@barstudio/shared';
import { interpolate, progressToOrderF, totalDuration, type Dataset } from '../renderer/frames';
import { renderer } from '../renderer/engine';
import type { Palette } from '../renderer/palettes';

export type ExportStage = 'prepare' | 'record' | 'transcode' | 'done';

export interface ExportProgress {
  stage: ExportStage;
  /** 0-1 */
  progress: number;
  message: string;
}

export interface ExportVideoOptions {
  config: RenderConfig;
  dataset: Dataset;
  palette: Palette;
  colorOf: (entity: string) => string;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  format: 'mp4' | 'webm';
  durationMs: number;
  fileName: string;
}

function pickMimeType(): { mime: string; direct: boolean } {
  const candidates: { mime: string; direct: boolean }[] = [
    { mime: 'video/mp4;codecs=avc1.42E01E', direct: true },  // Chrome 126+ 直录 H.264
    { mime: 'video/webm;codecs=vp9', direct: false },
    { mime: 'video/webm;codecs=vp8', direct: false },
    { mime: 'video/webm', direct: false },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  throw new Error('当前浏览器不支持 MediaRecorder，请使用 Chrome / Edge');
}

async function loadFfmpeg(onLog?: (msg: string) => void): Promise<any> {
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const { toBlobURL } = await import('@ffmpeg/util');
  const ffmpeg = new FFmpeg();
  if (onLog) ffmpeg.on('log', ({ message }: any) => onLog(message));
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
  const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
  await ffmpeg.load({ coreURL, wasmURL });
  return ffmpeg;
}

export async function exportVideo(opts: ExportVideoOptions): Promise<ExportResult> {
  const { config, dataset, palette, colorOf, onProgress, signal } = opts;
  const report = (stage: ExportStage, progress: number, message: string) =>
    onProgress?.({ stage, progress, message });

  if (dataset.times.length === 0) throw new Error('没有数据，无法导出');

  // ---- 准备离屏画布 ----
  report('prepare', 0, '准备导出画布…');
  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('无法创建 2D 绘图上下文');

  // ---- 预算实体名标签区宽度（dataset.entities 全集一次性预算，保持跨帧稳定）----
  const s = config.width / 1920;
  const fs = config.fontScale;
  const nameFont = `700 ${30 * s * fs}px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif`;
  const measuredName = renderer.measureLabelWidth(dataset.entities, nameFont, ctx);
  const labelWidth = Math.min(460 * s, Math.max(120 * s, measuredName));

  const { mime, direct } = pickMimeType();

  const manualMode = (() => {
    try {
      const probe = document.createElement('canvas');
      const st = (probe as any).captureStream(0);
      return typeof (st.getVideoTracks()[0] as any).requestFrame === 'function';
    } catch {
      return false;
    }
  })();

  const stream: MediaStream = (canvas as any).captureStream(manualMode ? 0 : config.fps);
  const track = stream.getVideoTracks()[0] as any;

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: config.videoBitsPerSecond,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (e: any) => reject(new Error(`录制出错: ${e?.error?.name ?? 'unknown'}`));
  });

  const duration = totalDuration(dataset, config.secondsPerStep, config.headHold, config.tailHold);
  const frameInterval = 1000 / config.fps;
  const startedAt = performance.now();

  report('record', 0, `开始录制（${direct ? '直录 mp4' : '录制 WebM'}，${config.width}×${config.height}@${config.fps}fps）…`);

  recorder.start(1000);

  // ---- 墙钟驱动渲染循环：按目标帧时刻自校正漂移 ----
  await new Promise<void>((resolve, reject) => {
    const drawOptions = { width: config.width, height: config.height, config, palette, colorOf, labelWidth };

    const drawAt = (elapsedMs: number) => {
      const p = Math.min(elapsedMs / 1000 / duration, 1);
      const orderF = progressToOrderF(dataset, p, config.secondsPerStep, config.headHold, config.tailHold);
      const frame = interpolate(dataset, orderF, config.maxBars);
      renderer.draw(frame, drawOptions, ctx);
    };

    // 首帧立即绘制
    drawAt(0);
    if (manualMode) track.requestFrame();

    let frameIndex = 0;
    const tick = () => {
      if (signal?.aborted) {
        try { recorder.stop(); } catch { /* noop */ }
        reject(new DOMException('已取消导出', 'AbortError'));
        return;
      }
      const targetMs = frameIndex * frameInterval;
      const now = performance.now() - startedAt;
      if (targetMs > now) {
        setTimeout(tick, Math.max(0, targetMs - now));
        return;
      }
      if (now >= duration * 1000 + 120) {
        // 收尾：定格尾帧已画，多留 120ms 缓冲后停止
        try { recorder.stop(); } catch { /* noop */ }
        resolve();
        return;
      }
      drawAt(now);
      if (manualMode) track.requestFrame();
      frameIndex++;
      report('record', Math.min(now / 1000 / duration, 1), `录制中 ${(Math.min(now / 1000, duration)).toFixed(1)}s / ${duration.toFixed(1)}s`);
      setTimeout(tick, 0); // 立即排下一帧（由 targetMs 自校正等待）
    };
    setTimeout(tick, frameInterval);
  });

  await stopped;
  const recordedMs = performance.now() - startedAt;

  if (signal?.aborted) throw new DOMException('已取消导出', 'AbortError');
  if (chunks.length === 0) throw new Error('录制结果为空（浏览器可能限制了后台标签页渲染，请保持页面在前台重试）');

  const rawBlob = new Blob(chunks, { type: mime.split(';')[0] });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const baseName = (config.title || 'bar-chart-race').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

  if (direct) {
    report('done', 1, '导出完成（mp4 直录）');
    return { blob: rawBlob, format: 'mp4', durationMs: Math.round(duration * 1000), fileName: `${baseName}-${stamp}.mp4` };
  }

  // ---- ffmpeg.wasm: WebM → H.264 mp4 ----
  report('transcode', 0, '加载转码内核（首次约 30MB，之后有缓存）…');
  try {
    const ffmpeg = await loadFfmpeg();
    const { fetchFile } = await import('@ffmpeg/util');
    await ffmpeg.writeFile('in.webm', await fetchFile(rawBlob));
    ffmpeg.on('progress', ({ progress }: any) => {
      if (Number.isFinite(progress)) {
        report('transcode', Math.min(Math.max(progress, 0), 1), `转码 mp4 ${(Math.min(Math.max(progress, 0), 1) * 100).toFixed(0)}%`);
      }
    });
    report('transcode', 0, '转码中（H.264 / yuv420p / faststart）…');
    await ffmpeg.exec([
      '-i', 'in.webm',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-r', String(config.fps),
      'out.mp4',
    ]);
    const data = await ffmpeg.readFile('out.mp4');
    const blob = new Blob([data], { type: 'video/mp4' });
    try { await ffmpeg.deleteFile('in.webm'); await ffmpeg.deleteFile('out.mp4'); } catch { /* noop */ }
    report('done', 1, '导出完成');
    return { blob, format: 'mp4', durationMs: Math.round(duration * 1000), fileName: `${baseName}-${stamp}.mp4` };
  } catch (err: any) {
    // 降级：交付 WebM（方案 §9 备选路径）
    const msg = err?.message ?? String(err);
    report('done', 1, `ffmpeg 转码失败（${msg}），已降级保存 WebM`);
    return {
      blob: rawBlob,
      format: 'webm',
      durationMs: Math.round(recordedMs),
      fileName: `${baseName}-${stamp}.webm`,
    };
  }
}
