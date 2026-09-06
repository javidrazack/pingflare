<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte'
  import { api, type OperationsOverview } from '$lib/api'
  import { t, locale } from '$lib/i18n'
  import Icon from '$lib/components/Icon.svelte'
  export let compact = false
  export let additionalScheduled = 0
  export let additionalInbound = 0
  const dispatch = createEventDispatcher<{ health: { warning: string | null } }>()
  let data: OperationsOverview | null = null
  let loading = false
  let failed = false
  let detailsOpen = false
  export function reveal() { detailsOpen = true }
  async function load() {
    if (loading) return
    loading = true
    failed = false
    try { data = await api.operations.overview() }
    catch { failed = true }
    finally { loading = false }
  }
  onMount(load)
  $: demand = (data?.scheduledPerMinute ?? 0) + additionalScheduled
  $: outageDemand = demand + (data?.inboundPerMinute ?? 0) + additionalInbound
  $: overloaded = data && demand > data.normalChecksPerMinute
  $: atRisk = data && outageDemand > data.conservativeChecksPerMinute
  $: warning = failed ? 'ops.unavailable' : !data ? null
    : !compact && (data.scheduler.failed || data.scheduler.stale) ? 'ops.engineWarning'
    : !compact && data.overdue > 0 ? 'ops.overdueWarning'
    : overloaded ? 'ops.overloaded' : atRisk ? 'ops.atRisk' : null
  $: if (!compact) dispatch('health', { warning })
  function time(value: number | null) {
    return value ? new Date(value * 1000).toLocaleString($locale) : $t('ops.never')
  }
</script>

<section id={compact ? 'monitor-capacity-preview' : 'monitoring-engine'} class="card space-y-4" aria-labelledby={compact ? 'capacity-form-title' : 'capacity-title'} aria-busy={loading}>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 id={compact ? 'capacity-form-title' : 'capacity-title'} class="text-lg font-semibold">{compact ? $t('ops.heading') : $t('ops.engine')}</h2>
      <p class="mt-1 text-xs muted">{data ? $t('ops.updatedManual', { time: time(data.observedAt) }) : $t('ops.manual')}</p>
    </div>
    <button type="button" class="btn-outline" on:click={load} disabled={loading}><Icon name="arrow-path" size={16} />{loading ? $t('event.refreshing') : $t('ops.refresh')}</button>
  </div>
  {#if failed}<p role="alert" class="text-sm" style="color: var(--danger-fg)">{$t('ops.loadFailed')} {data ? $t('event.previousSnapshot') : ''}</p>{/if}
  {#if data}
    <div class="summary-row">
      <div class="min-w-0" role="status">
        <p class="flex items-center gap-2 font-medium" style="color: {warning ? 'var(--warning-fg)' : 'var(--success-fg)'}">
          <Icon name={warning ? 'exclamation-triangle' : 'check-circle'} size={18} />
          {warning ? $t('ops.needsAttention') : compact ? $t('ops.withinCapacity') : $t('ops.keepingUp')}
        </p>
        {#if !compact}<p class="mt-1 text-sm muted">{data.overdue ? $t('ops.overdueCount', { count: data.overdue }) : $t('ops.noOverdue')}</p>{/if}
      </div>
      <p class="text-sm tabular-nums"><span class="block font-medium">{$t('ops.demandSummary', { demand: demand.toFixed(2), capacity: data.normalChecksPerMinute })}</span><span class="mt-1 block muted">{$t('ops.scheduledChecks')}</span></p>
    </div>
    {#if warning && !failed}<p role="status" class="text-sm warning">{$t(warning as Parameters<typeof $t>[0])}</p>{/if}
    <details bind:open={detailsOpen} class="capacity-details">
      <summary>{$t('ops.details')}</summary>
      <div class="details-body">
        <section aria-label={$t('ops.capacityPlanning')}>
          <h3 class="font-semibold text-sm">{$t('ops.capacityPlanning')}</h3>
          <dl class="mt-3 grid gap-4 sm:grid-cols-2">
            <div><dt class="text-sm muted">{$t('ops.normalSchedule')}</dt><dd class="mt-1 tabular-nums">{$t('ops.rateSummary', { demand: demand.toFixed(2), capacity: data.normalChecksPerMinute })}</dd></div>
            <div><dt class="text-sm muted">{$t('ops.outageScenario')}</dt><dd class="mt-1 tabular-nums">{$t('ops.rateSummary', { demand: outageDemand.toFixed(2), capacity: data.conservativeChecksPerMinute })}</dd></div>
          </dl>
          <p class="mt-3 text-sm muted">{$t('ops.scenarioHelp')}</p>
          {#if !compact}<a class="btn-outline mt-3" href="/monitors">{$t('ops.reviewSchedule')}</a>{/if}
        </section>
        {#if !compact}
          <section aria-label={$t('ops.schedulerHealth')}>
            <h3 class="text-sm font-semibold">{$t('ops.schedulerHealth')}</h3>
            <dl class="mt-3 grid gap-4 sm:grid-cols-2">
              <div><dt class="text-sm muted">{$t('ops.lastRun')}</dt><dd class="mt-1 text-sm tabular-nums">{time(data.scheduler.lastCompletedAt)}</dd></div>
              <div><dt class="text-sm muted">{$t('ops.overdue')}</dt><dd class="mt-1 text-sm">{data.overdue ? $t('ops.overdueCount', { count: data.overdue }) : $t('ops.noOverdue')}{#if data.overdue} · {$t('ops.oldest', { minutes: Math.ceil((data.oldestOverdueSeconds ?? 0) / 60) })}{/if}</dd></div>
            </dl>
          </section>
          <details class="usage-details">
            <summary>{$t('ops.usageDetails')}</summary>
            <p class="mt-3 text-sm">{$t('ops.reservation')}: <span class="font-medium tabular-nums">{(data.publicReadReservation.used / data.publicReadReservation.limit * 100).toFixed(1)}%</span></p>
            <p class="mt-2 text-sm muted">{$t('ops.usageHelp')}</p>
          </details>
        {/if}
        <p class="text-xs muted">{compact ? $t('ops.currentOnly') : $t('ops.limitHelp')}</p>
      </div>
    </details>
  {:else if loading}<p role="status" class="text-sm muted">{$t('ops.loading')}</p>{/if}
</section>

<style>
  section[id] { scroll-margin-top: 5rem; }
  .muted { color: rgb(var(--text-muted)); }
  .summary-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem 2rem; }
  .warning { padding: .75rem; border-radius: .5rem; background: rgb(var(--warning-bg)); color: var(--warning-fg); }
  .capacity-details { border-top: 1px solid var(--border-color); padding-top: .25rem; }
  summary { display: flex; justify-content: space-between; align-items: center; gap: 1rem; min-height: 2.75rem; cursor: pointer; font-size: .875rem; font-weight: 500; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: ''; width: .45rem; height: .45rem; flex-shrink: 0; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); margin-right: .25rem; }
  details[open] > summary::after { transform: rotate(225deg); }
  summary:hover { color: var(--color-primary); }
  .details-body { display: grid; gap: 1.5rem; padding-top: .75rem; }
  .details-body > section + section, .usage-details { border-top: 1px solid var(--border-color); padding-top: 1rem; }
</style>
