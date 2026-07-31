<script lang="ts">
  import type { AgentMetricHistory, AgentMetricPoint } from '$lib/api'
  import { formatTs } from '$lib/utils'

  export let history: AgentMetricHistory
  export let height = 180

  $: points = history.points
  $: cpuAverage = average(points.map((point) => point.cpu.avg))
  $: ramAverage = average(points.map((point) => point.ram.avg))
  $: cpuMaximum = maximum(points.map((point) => point.cpu.max))
  $: ramMaximum = maximum(points.map((point) => point.ram.max))

  let chartElement: HTMLDivElement
  let selectedIndex: number | null = null

  function average(values: number[]): number | null {
    if (values.length === 0) return null
    return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 10) / 10
  }

  function maximum(values: number[]): number | null {
    return values.length > 0 ? Math.max(...values) : null
  }

  function xPercent(index: number): number {
    return (index / Math.max(1, points.length - 1)) * 100
  }

  function yPosition(value: number): number {
    return height - (Math.min(100, Math.max(0, value)) / 100) * height
  }

  function linePath(metric: 'cpu' | 'ram'): string {
    return points.map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${xPercent(index)} ${yPosition(point[metric].avg)}`,
    ).join(' ')
  }

  function thresholdY(value: number | null): number | null {
    return value === null ? null : yPosition(value)
  }

  function selectFromPointer(event: MouseEvent) {
    if (!chartElement || points.length === 0) return
    const rect = chartElement.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
    selectedIndex = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))))
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || points.length === 0) return
    event.preventDefault()
    if (event.key === 'Home') selectedIndex = 0
    else if (event.key === 'End') selectedIndex = points.length - 1
    else {
      const current = selectedIndex ?? points.length - 1
      selectedIndex = Math.max(0, Math.min(
        points.length - 1,
        current + (event.key === 'ArrowRight' ? 1 : -1),
      ))
    }
  }

  $: selected = selectedIndex === null ? null : points[selectedIndex]
  $: selectedX = selectedIndex === null ? null : xPercent(selectedIndex)
</script>

{#if points.length < 2}
  <div class="flex min-h-44 items-center justify-center text-sm" style="color: rgb(var(--text-muted))">
    Historical data will appear after two five-minute samples.
  </div>
{:else}
  <div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
    <div>
      <div class="text-xs" style="color: rgb(var(--text-muted))">CPU average</div>
      <div class="mt-1 font-mono text-lg font-semibold tabular-nums">{cpuAverage}%</div>
    </div>
    <div>
      <div class="text-xs" style="color: rgb(var(--text-muted))">CPU peak</div>
      <div class="mt-1 font-mono text-lg font-semibold tabular-nums">{cpuMaximum}%</div>
    </div>
    <div>
      <div class="text-xs" style="color: rgb(var(--text-muted))">RAM average</div>
      <div class="mt-1 font-mono text-lg font-semibold tabular-nums">{ramAverage}%</div>
    </div>
    <div>
      <div class="text-xs" style="color: rgb(var(--text-muted))">RAM peak</div>
      <div class="mt-1 font-mono text-lg font-semibold tabular-nums">{ramMaximum}%</div>
    </div>
  </div>

  <div class="flex gap-3 text-xs" style="color: rgb(var(--text-muted))">
    <span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-4 bg-amber-600"></span>CPU</span>
    <span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-4 bg-sky-500"></span>RAM</span>
    <span class="ml-auto">0–100%</span>
  </div>

  <div
    bind:this={chartElement}
    role="slider"
    tabindex="0"
    aria-valuemin="0"
    aria-valuemax={points.length - 1}
    aria-valuenow={selectedIndex ?? points.length - 1}
    aria-valuetext={selected
      ? `${formatTs(selected.sampledAt)}, CPU ${selected.cpu.avg} percent, RAM ${selected.ram.avg} percent`
      : `Latest sample, CPU ${points[points.length - 1].cpu.avg} percent, RAM ${points[points.length - 1].ram.avg} percent`}
    aria-label="CPU and RAM usage history. Use left and right arrow keys to inspect samples."
    class="relative mt-3 cursor-crosshair rounded-lg"
    style="height:{height}px; background: rgb(var(--bg-subtle))"
    on:mousemove={selectFromPointer}
    on:mouseleave={() => selectedIndex = null}
    on:focus={() => selectedIndex = points.length - 1}
    on:keydown={handleKeydown}
  >
    <svg viewBox="0 0 100 {height}" preserveAspectRatio="none" class="h-full w-full overflow-visible">
      {#each [25, 50, 75] as gridValue}
        <line
          x1="0"
          x2="100"
          y1={yPosition(gridValue)}
          y2={yPosition(gridValue)}
          stroke="rgb(var(--text-muted))"
          stroke-opacity="0.16"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />
      {/each}
      {#each [
        { value: history.thresholds.cpu, color: '#b45309' },
        { value: history.thresholds.ram, color: '#0ea5e9' },
      ] as threshold}
        {@const y = thresholdY(threshold.value)}
        {#if y !== null}
          <line
            x1="0"
            x2="100"
            y1={y}
            y2={y}
            stroke={threshold.color}
            stroke-opacity="0.55"
            stroke-dasharray="4 4"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
        {/if}
      {/each}
      <path
        d={linePath('cpu')}
        fill="none"
        stroke="#b45309"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      />
      <path
        d={linePath('ram')}
        fill="none"
        stroke="#0ea5e9"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      />
    </svg>

    {#if selectedX !== null}
      <div
        class="pointer-events-none absolute inset-y-0 w-px"
        style="left:{selectedX}%; background: rgb(var(--text-muted) / .4)"
      ></div>
    {/if}
  </div>

  <div class="mt-2 min-h-6 text-xs" aria-live="polite" style="color: rgb(var(--text-muted))">
    {#if selected}
      <span class="tabular-nums">{formatTs(selected.sampledAt)}</span>
      <span class="ml-3 font-mono text-amber-700 dark:text-amber-400">CPU {selected.cpu.avg}%</span>
      <span class="ml-3 font-mono text-sky-600 dark:text-sky-400">RAM {selected.ram.avg}%</span>
    {:else}
      <span>Five-minute samples. Dashed lines show configured thresholds.</span>
    {/if}
  </div>
{/if}
