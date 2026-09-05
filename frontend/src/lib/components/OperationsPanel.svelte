<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type OperationsOverview } from '$lib/api'
  import { t, locale } from '$lib/i18n'
  export let compact = false
  export let additionalScheduled = 0
  export let additionalInbound = 0
  let data: OperationsOverview | null = null
  let loading = false
  let failed = false
  async function load() {
    loading = true
    failed = false
    try { data = await api.operations.overview() }
    catch { failed = true }
    finally { loading = false }
  }
  onMount(load)
  $: overloaded = data && (data.scheduledPerMinute + additionalScheduled) > data.normalChecksPerMinute
  $: atRisk = data && (data.scheduledPerMinute + additionalScheduled) + (data.inboundPerMinute + additionalInbound) > data.conservativeChecksPerMinute
  function time(value: number | null) {
    return value ? new Date(value * 1000).toLocaleString($locale) : $t('ops.never')
  }
</script>

<section class="card space-y-4" aria-labelledby={compact ? 'capacity-form-title' : 'capacity-title'} aria-busy={loading}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 id={compact ? 'capacity-form-title' : 'capacity-title'} class="text-lg font-semibold">{$t('ops.heading')}</h2>
    <button type="button" class="btn-outline" on:click={load} disabled={loading}>{$t('ops.refresh')}</button>
  </div>
  {#if failed}<p role="alert" style="color: var(--danger-fg)">{$t('ops.loadFailed')}</p>{/if}
  {#if data}
    <p class="text-sm" style="color: rgb(var(--text-muted))">{$t('ops.snapshot', { time: time(data.observedAt) })}</p>
    <dl class="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      <div><dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('ops.demand')}</dt>
        <dd class="mt-1 font-mono">{(data.scheduledPerMinute + additionalScheduled).toFixed(2)} / {data.normalChecksPerMinute} {$t('ops.perMinute')}</dd></div>
      <div><dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('ops.failureDemand')}</dt>
        <dd class="mt-1 font-mono">{((data.scheduledPerMinute + additionalScheduled) + (data.inboundPerMinute + additionalInbound)).toFixed(2)} / {data.conservativeChecksPerMinute} {$t('ops.perMinute')}</dd></div>
      {#if !compact}
        <div><dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('ops.lastRun')}</dt><dd class="mt-1">{time(data.scheduler.lastCompletedAt)}</dd></div>
        <div><dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('ops.overdue')}</dt><dd class="mt-1">{data.overdue} · {$t('ops.oldest', { minutes: Math.ceil((data.oldestOverdueSeconds ?? 0) / 60) })}</dd></div>
        <div><dt class="text-sm" style="color: rgb(var(--text-muted))">{$t('ops.reservation')}</dt><dd class="mt-1">{(data.publicReadReservation.used / data.publicReadReservation.limit * 100).toFixed(1)}%</dd></div>
      {/if}
    </dl>
    {#if overloaded || atRisk}
      <p class="alert text-sm" style="background: rgb(var(--warning-bg)); color: var(--warning-fg)">{overloaded ? $t('ops.overloaded') : $t('ops.atRisk')}</p>
    {/if}
    {#if !compact && (data.scheduler.failed || data.scheduler.stale)}
      <p class="alert text-sm" role="status" style="background: rgb(var(--warning-bg)); color: var(--warning-fg)">{$t('ops.engineWarning')}</p>
    {/if}
    <p class="text-xs" style="color: rgb(var(--text-muted))">{compact ? $t('ops.currentOnly') : $t('ops.note')}</p>
  {:else if loading}<p role="status">{$t('ops.loading')}</p>{/if}
</section>
