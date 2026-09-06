<script lang="ts">
  import { formatRelative, formatUptime, parseTags } from '$lib/utils'
  import type { MonitorSummary } from '$lib/api'
  import { t, locale } from '$lib/i18n'
  import StatusBadge from '$lib/components/StatusBadge.svelte'

  export let monitor: MonitorSummary
  export let uptime: number | null = null

  $: isDown = (monitor.displayStatus ?? monitor.lastStatus) === 'down'
  $: isPending = !['up', 'down'].includes(monitor.displayStatus ?? monitor.lastStatus)
  $: isUp = (monitor.displayStatus ?? monitor.lastStatus) === 'up'

  $: accentColor = isDown
    ? 'var(--danger-fg)'
    : isPending
    ? 'var(--pending-fg)'
    : 'var(--success-fg)'

  $: cardBorderColor = isDown
    ? 'color-mix(in srgb, var(--danger-fg) 45%, transparent)'
    : 'var(--border-color)'
</script>

<a href="/monitors/{monitor.id}"
  class="monitor-card group relative flex items-center gap-3 overflow-hidden rounded-xl cursor-pointer"
  style="
    background-color: rgb(var(--card));
    --monitor-border: {cardBorderColor};
    padding: 1rem 1.25rem;
  ">

  <div class="absolute left-0 top-0 bottom-0 w-0.5 transition-all"
    style="background-color: {accentColor}; opacity: {isUp ? '0.5' : '1'}"></div>

  <div class="min-w-0 flex-1 pl-2">
    <div class="flex items-center gap-2 flex-wrap">
      <span class="font-semibold text-sm transition-colors group-hover:text-[var(--color-primary)]"
        style="color: rgb(var(--text))">
        {monitor.name}
      </span>
      <span class="text-xs px-2 py-0.5 rounded font-medium"
        style="background-color: rgb(var(--bg-muted)); color: rgb(var(--text-muted))">
        {monitor.type}
      </span>
      <StatusBadge status={monitor.displayStatus ?? monitor.lastStatus} />
      {#each parseTags(monitor.tags) as tag}
        <span class="text-xs px-2 py-0.5 rounded font-medium"
          style="background: color-mix(in srgb, var(--color-primary) 10%, transparent); color: var(--color-primary)">
          {tag}
        </span>
      {/each}
    </div>
    {#if monitor.url}
      <p class="mt-0.5 text-xs font-mono truncate" style="color: rgb(var(--text-muted))">{monitor.url}</p>
    {/if}
  </div>

  <div class="shrink-0 flex items-center gap-6 text-xs" style="color: rgb(var(--text-muted))">
    {#if uptime !== null}
      <div class="text-right hidden sm:block">
        <div class="font-semibold tabular-nums" style="color: {accentColor}">
          {formatUptime(uptime)}
        </div>
        <div class="mt-0.5 text-[11px]">{$t('monitorCard.uptime')}</div>
      </div>
    {/if}
    <div class="text-right hidden md:block">
      <div class="font-medium tabular-nums" style="color: rgb(var(--text))">{monitor.interval}s</div>
      <div class="mt-0.5 text-[11px]">{$t('monitorCard.interval')}</div>
    </div>
    <div class="hidden text-right sm:block">
      <div class="font-medium" style="color: rgb(var(--text))">{formatRelative(monitor.lastCheckedAt, $locale)}</div>
      <div class="mt-0.5 text-[11px]">{$t('monitorCard.lastCheck')}</div>
    </div>
  </div>

  <svg class="shrink-0 opacity-40 group-hover:opacity-100 transition-opacity" width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    style="color: rgb(var(--text-muted))">
    <path d="M9 18l6-6-6-6"/>
  </svg>

</a>

<style>
  .monitor-card {
    border: 1px solid var(--monitor-border);
    transition: border-color 180ms ease, background-color 180ms ease, transform 180ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 180ms ease;
  }

  .monitor-card:hover {
    border-color: var(--color-primary);
    background-color: color-mix(in srgb, var(--color-primary) 4%, rgb(var(--card))) !important;
    box-shadow: 0 8px 22px -20px rgb(120 53 15 / 0.8);
    transform: translateX(2px);
  }

  .monitor-card svg:last-child {
    transition: opacity 180ms ease, transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .monitor-card:hover svg:last-child {
    transform: translateX(2px);
  }
</style>
