<script lang="ts">
  import type { DailyUptime } from '$lib/api'

  export let data: DailyUptime[] = []
  export let days = 90

  function colorFor(uptime: number | null): string {
    if (uptime === null) return 'bg-neutral-200 dark:bg-neutral-600'
    if (uptime >= 99) return 'bg-green-500'
    if (uptime >= 95) return 'bg-green-400'
    if (uptime >= 80) return 'bg-yellow-400'
    return 'bg-red-400'
  }

  function labelFor(d: DailyUptime): string {
    if (d.uptime === null) return `${d.date}: no data`
    return `${d.date}: ${d.uptime.toFixed(1)}%`
  }
</script>

<div class="space-y-1" role="img"
  aria-label="{days}-day uptime history. Green is operational, yellow is degraded, red is outage, and gray is no data.">
  <div class="flex gap-0.5">
    {#each data as day}
      <div
        class="flex-1 h-5 rounded-sm {colorFor(day.uptime)} cursor-default transition-opacity hover:opacity-80"
        aria-label={labelFor(day)}
      ></div>
    {/each}
  </div>
  <div class="flex justify-between text-xs text-[rgb(var(--text-muted))]">
    <span>{days} days ago</span>
    <span>Today</span>
  </div>
</div>
