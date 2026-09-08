<template>
  <div class="timeline">
    <button class="tl-btn" :title="playing ? '暂停' : '播放'" @click="$emit('toggle')">
      {{ playing ? '❚❚' : '▶' }}
    </button>
    <button class="tl-btn" title="上一时间点" @click="$emit('step', -1)">⏮</button>
    <button class="tl-btn" title="下一时间点" @click="$emit('step', 1)">⏭</button>

    <span class="tl-time">{{ timeLabel }}</span>

    <input
      class="tl-slider"
      type="range"
      min="0"
      max="1000"
      :value="Math.round(progress * 1000)"
      @input="$emit('seek', Number(($event.target as HTMLInputElement).value) / 1000)"
    />

    <select class="tl-speed" :value="speed" @change="$emit('speed', Number(($event.target as HTMLSelectElement).value))">
      <option :value="0.5">0.5×</option>
      <option :value="1">1×</option>
      <option :value="2">2×</option>
      <option :value="4">4×</option>
    </select>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  playing: boolean;
  progress: number;
  speed: number;
  timeLabel: string;
}>();

defineEmits<{
  (e: 'toggle'): void;
  (e: 'seek', p: number): void;
  (e: 'speed', v: number): void;
  (e: 'step', dir: 1 | -1): void;
}>();
</script>

<style scoped>
.timeline {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-top: 12px;
}
.tl-btn {
  width: 38px; height: 34px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 14px;
}
.tl-time {
  min-width: 90px; text-align: center; font-weight: 700;
  font-family: 'DIN Alternate', 'Bahnschrift', 'Roboto Mono', monospace;
  font-size: 15px; color: var(--text);
}
.tl-slider { flex: 1; accent-color: var(--accent); }
.tl-speed { width: 84px; }
</style>
