<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { api, ApiError, type MonitorSummary } from '$lib/api'
  import { monitors, dashboardHealth } from '$lib/stores'
  import { t, locale, nMonitors } from '$lib/i18n'
  import MonitorCard from '$lib/components/MonitorCard.svelte'
  import OperationsPanel from '$lib/components/OperationsPanel.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import PageLoader from '$lib/components/PageLoader.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'

  type LoadState = 'loading' | 'ready' | 'error'

  let totals = { total: 0, up: 0, down: 0, pending: 0, stale: 0 }
  let watchlist: MonitorSummary[] = []
  let currentState: LoadState = 'loading'
  let analyticsState: LoadState = 'loading'
  let hasCurrentData = false
  let hasAnalyticsData = false
  let currentError = ''
  let analyticsError = ''
  let actionError = ''
  let actionNotice = ''
  let running = false
  let lastRun: Date | null = null
  let currentUpdatedAt: Date | null = null
  let analyticsUpdatedAt: Date | null = null
  let currentRevision = 0
  let uptimes: Record<string, number | null> = {}
  let currentTicker: ReturnType<typeof setTimeout>
  let analyticsTicker: ReturnType<typeof setTimeout>
  let currentInFlight = false
  let analyticsInFlight = false
  let destroyed = false

  function recoveryMessage(error: unknown, fallbackKey: 'dashboard.errorCurrent' | 'dashboard.errorAnalytics' | 'dashboard.errorManual') {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return $t('dashboard.errorOffline')
    }
    if (error instanceof ApiError) {
      if (error.status === 403) return $t('dashboard.errorForbidden')
      if (error.status === 429) return $t('dashboard.errorRateLimited')
    }
    return $t(fallbackKey)
  }

  function formatTime(value: Date) {
    return new Intl.DateTimeFormat($locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(value)
  }

  async function loadCurrent(foreground = false) {
    if (currentInFlight || (typeof document !== 'undefined' && document.hidden)) return
    if (foreground && !hasCurrentData) currentState = 'loading'
    currentInFlight = true
    try {
      const result = await api.operations.dashboard()
      totals = result.summary
      dashboardHealth.set(result.summary)
      monitors.set(result.items)
      hasCurrentData = true
      currentState = 'ready'
      currentUpdatedAt = new Date()
      currentRevision += 1
      currentError = ''
    } catch (e) {
      currentState = 'error'
      currentError = recoveryMessage(e, 'dashboard.errorCurrent')
    } finally {
      currentInFlight = false
    }
  }

  async function loadAnalytics(foreground = false) {
    if (analyticsInFlight || (typeof document !== 'undefined' && document.hidden)) return
    if (foreground && !hasAnalyticsData) analyticsState = 'loading'
    analyticsInFlight = true
    try {
      const result = await api.operations.watchlist()
      watchlist = result.items
      uptimes = Object.fromEntries(result.items.map(m => [m.id, m.uptime]))
      hasAnalyticsData = true
      analyticsState = 'ready'
      analyticsUpdatedAt = new Date()
      analyticsError = ''
    } catch (e) {
      analyticsState = 'error'
      analyticsError = recoveryMessage(e, 'dashboard.errorAnalytics')
    } finally {
      analyticsInFlight = false
    }
  }

  async function load() {
    await Promise.all([loadCurrent(), loadAnalytics()])
  }

  function scheduleCurrent() {
    clearTimeout(currentTicker)
    if (!destroyed) currentTicker = setTimeout(async () => {
      await loadCurrent()
      scheduleCurrent()
    }, 30_000)
  }

  function scheduleAnalytics() {
    clearTimeout(analyticsTicker)
    if (!destroyed) analyticsTicker = setTimeout(async () => {
      await loadAnalytics()
      scheduleAnalytics()
    }, 5 * 60_000)
  }

  function handleVisibility() {
    if (!document.hidden) {
      void loadCurrent()
      void loadAnalytics()
      scheduleCurrent()
      scheduleAnalytics()
    }
  }

  async function runChecks() {
    running = true
    actionError = ''
    actionNotice = ''
    try {
      const result = await api.cron.run()
      if (result.skippedBecauseLeased) {
        actionNotice = $t('dashboard.checksAlreadyRunning')
        return
      }
      lastRun = new Date()
      await load()
    } catch (e) {
      actionError = recoveryMessage(e, 'dashboard.errorManual')
    } finally {
      running = false
    }
  }

  onMount(() => {
    void load().finally(() => {
      scheduleCurrent()
      scheduleAnalytics()
    })
    document.addEventListener('visibilitychange', handleVisibility)
  })
  onDestroy(() => {
    destroyed = true
    clearTimeout(currentTicker)
    clearTimeout(analyticsTicker)
    document.removeEventListener('visibilitychange', handleVisibility)
  })

  $: total = totals.total
  $: up = totals.up
  $: down = totals.down
  $: pending = totals.pending
  $: stale = totals.stale
  $: allUp = up > 0 && down === 0 && pending === 0 && stale === 0 && currentState === 'ready'
  $: attention = $monitors

  $: downLabel    = `${nMonitors($locale, down)} ${$t('dashboard.down').toLowerCase()}`
  $: pendingSummary = $t(
    pending === 1 ? 'dashboard.pendingSummaryOne' : 'dashboard.pendingSummaryMany',
    { n: nMonitors($locale, pending) },
  )
  $: pendingLabel = (() => {
    const key = pending === 1 ? 'dashboard.pendingLabelOne' : 'dashboard.pendingLabelMany'
    return $t(key, { n: nMonitors($locale, pending), action: $t('dashboard.runChecks') })
  })()
</script>

<svelte:head><title>{$t('dashboard.heading')} - Pingflare</title></svelte:head>

<div style="background-color: rgb(var(--bg))">

  <div class="dashboard-header relative overflow-hidden" style="border-bottom: 1px solid var(--border-color)">
    <HeaderPattern />

    <div class="dashboard-intro relative mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-12">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {#if allUp && total > 0}
            <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded mb-2"
              style="background: rgb(var(--success-bg)); color: var(--success-fg); border: 1px solid color-mix(in srgb, var(--success-fg) 20%, transparent)">
              <span class="w-1.5 h-1.5 rounded-full inline-block" style="background: var(--success-fg)"></span>
              {$t('dashboard.allOperational')}
            </span>
          {:else if down > 0}
            <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded mb-2"
              style="background: rgb(var(--danger-bg)); color: var(--danger-fg); border: 1px solid color-mix(in srgb, var(--danger-fg) 20%, transparent)">
              <span class="w-1.5 h-1.5 rounded-full inline-block" style="background: var(--danger-fg)"></span>
              {downLabel}
            </span>
          {:else if stale > 0}
            <span class="badge badge-pending mb-2">{$t('dashboard.staleCount', { count: stale })}</span>
          {:else if pending > 0}
            <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded mb-2"
              style="background: rgb(var(--pending-bg)); color: var(--pending-fg); border: 1px solid color-mix(in srgb, var(--pending-fg) 20%, transparent)">
              <span class="w-1.5 h-1.5 rounded-full inline-block" style="background: var(--pending-fg)"></span>
              {pendingSummary}
            </span>
          {/if}
          <h1 class="dashboard-heading" style="color: rgb(var(--text))">{$t('dashboard.heading')}</h1>
          <p class="mt-3 max-w-2xl text-sm md:text-base" style="color: rgb(var(--text-muted))">
            {$t('dashboard.subtitle')}
          </p>
        </div>
        <div class="flex items-center gap-2 sm:shrink-0">
          <button class="btn-outline text-xs py-2" on:click={runChecks} disabled={running} title={$t('dashboard.runChecks')}>
            <Icon name="arrow-path" size={14} cls={running ? 'animate-spin' : ''} />
            <span>{running ? $t('dashboard.running') : $t('dashboard.runChecks')}</span>
          </button>
          <a href="/monitors/new" class="btn-primary">
            <Icon name="plus" size={14} />
            <span>{$t('dashboard.addMonitor')}</span>
          </a>
        </div>
      </div>

      {#if currentUpdatedAt || analyticsUpdatedAt || lastRun}
        <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" style="color: rgb(var(--text-muted))">
          {#if currentUpdatedAt}
            {#key currentRevision}
              <span class="freshness-receipt">
                <svg class="freshness-trace" viewBox="0 0 32 12" aria-hidden="true">
                  <path pathLength="1" d="M1 6h7l2-4 4 8 4-8 3 4h10" />
                </svg>
                {$t('dashboard.statusUpdatedAt', { time: formatTime(currentUpdatedAt) })}
              </span>
            {/key}
          {/if}
          {#if analyticsUpdatedAt}
            <span>{$t('dashboard.uptimeUpdatedAt', { time: formatTime(analyticsUpdatedAt) })}</span>
          {/if}
          {#if lastRun}
            <span>{$t('dashboard.lastManualRunAt', { time: formatTime(lastRun) })}</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <div class="px-4 py-5 md:px-8 md:py-8 max-w-7xl mx-auto space-y-6">

    {#if actionNotice}
      <div class="alert state-reveal items-center text-sm" role="status"
        style="background: rgb(var(--warning-bg)); color: var(--warning-fg)">
        <Icon name="clock" size={18} />
        <span class="min-w-0 flex-1">{actionNotice}</span>
        <button class="btn-ghost icon-button shrink-0 text-inherit" aria-label={$t('dashboard.dismissNotice')}
          on:click={() => actionNotice = ''}>
          <Icon name="x-mark" size={18} />
        </button>
      </div>
    {/if}

    {#if actionError}
      <div class="alert state-reveal flex-col text-sm sm:flex-row sm:items-center" role="alert"
        style="background: rgb(var(--danger-bg)); color: var(--danger-fg)">
        <Icon name="exclamation-triangle" size={18} />
        <div class="min-w-0 flex-1">
          <p class="font-semibold">{$t('dashboard.manualChecksFailedTitle')}</p>
          <p class="mt-0.5">{actionError}</p>
        </div>
        <div class="flex w-full gap-2 sm:w-auto">
          <button class="btn-outline flex-1 shrink-0 text-inherit sm:flex-none" on:click={runChecks} disabled={running}>
            <Icon name="arrow-path" size={16} cls={running ? 'animate-spin' : ''} />
            {$t('dashboard.tryAgain')}
          </button>
          <button class="btn-ghost icon-button shrink-0 text-inherit" aria-label={$t('dashboard.dismissError')}
            on:click={() => actionError = ''}>
            <Icon name="x-mark" size={18} />
          </button>
        </div>
      </div>
    {/if}

    {#if hasCurrentData && (total > 0 || up > 0 || down > 0 || pending > 0 || stale > 0)}
    <section class="status-overview">
      {#if total > 0}
      <div class="status-metric status-metric-total">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">{$t('dashboard.total')}</span>
          <div class="status-metric-icon"
            style="background: color-mix(in srgb, var(--color-primary) 13%, transparent); color: var(--color-primary)">
            <Icon name="signal" size={18} />
          </div>
        </div>
        <div class="status-metric-value tabular-nums" style="color: rgb(var(--text))">{total}</div>
        <div class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('dashboard.monitorsWord')}</div>
      </div>
      {/if}

      {#if up > 0}
      <div class="status-metric">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">{$t('dashboard.operational')}</span>
          <div class="status-metric-icon"
            style="background: rgb(var(--success-bg)); color: var(--success-fg)">
            <Icon name="check-circle" size={18} />
          </div>
        </div>
        <div class="status-metric-value tabular-nums" style="color: var(--success-fg)">{up}</div>
        <div class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('dashboard.runningFine')}</div>
      </div>
      {/if}

      {#if down > 0}
      <div class="status-metric" style="background: color-mix(in srgb, var(--danger-bg) 58%, rgb(var(--card)))">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">{$t('dashboard.down')}</span>
          <div class="status-metric-icon"
            style="background: rgb(var(--danger-bg)); color: var(--danger-fg)">
            <Icon name="x-circle" size={18} />
          </div>
        </div>
        <div class="status-metric-value tabular-nums" style="color: var(--danger-fg)">{down}</div>
        <div class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('dashboard.needAttention')}</div>
      </div>
      {/if}

      {#if pending > 0}
      <div class="status-metric">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">{$t('dashboard.pending')}</span>
          <div class="status-metric-icon"
            style="background: rgb(var(--pending-bg)); color: var(--pending-fg)">
            <Icon name="clock" size={18} />
          </div>
        </div>
        <div class="status-metric-value tabular-nums" style="color: var(--pending-fg)">{pending}</div>
        <div class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('dashboard.awaitingCheck')}</div>
      </div>
      {/if}
      {#if stale > 0}
      <div class="status-metric">
        <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">{$t('status.stale')}</span>
        <div class="status-metric-value tabular-nums mt-3" style="color: var(--warning-fg)">{stale}</div>
        <p class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('dashboard.staleHelp')}</p>
      </div>
      {/if}
    </section>
    {/if}

    {#if currentState === 'loading' && !hasCurrentData}
      <PageLoader label={$t('dashboard.loading')} />
    {:else if currentState === 'error' && !hasCurrentData}
      <section class="card state-reveal py-12 text-center" role="alert" aria-labelledby="dashboard-load-error-title">
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded"
          style="background: rgb(var(--danger-bg)); color: var(--danger-fg)">
          <Icon name="exclamation-triangle" size={22} />
        </div>
        <h2 id="dashboard-load-error-title" class="mt-4 text-lg font-semibold" style="color: rgb(var(--text))">
          {$t('dashboard.loadFailedTitle')}
        </h2>
        <p class="mx-auto mt-1 max-w-md text-sm" style="color: rgb(var(--text-muted))">{currentError}</p>
        <button class="btn-primary mt-5" on:click={() => loadCurrent(true)} disabled={currentInFlight}>
          <Icon name="arrow-path" size={16} cls={currentInFlight ? 'animate-spin' : ''} />
          {currentInFlight ? $t('dashboard.retrying') : $t('dashboard.tryAgain')}
        </button>
      </section>
    {:else if hasCurrentData}
      {#if currentState === 'error'}
        <div class="alert state-reveal flex-col text-sm sm:flex-row sm:items-center" role="alert"
          style="background: rgb(var(--warning-bg)); color: var(--warning-fg)">
          <Icon name="exclamation-triangle" size={18} />
          <div class="min-w-0 flex-1">
            <p class="font-semibold">{$t('dashboard.staleStatusTitle')}</p>
            <p class="mt-0.5">
              {currentUpdatedAt
                ? $t('dashboard.staleStatusAt', { time: formatTime(currentUpdatedAt) })
                : currentError}
            </p>
          </div>
          <button class="btn-outline w-full shrink-0 text-inherit sm:w-auto" on:click={() => loadCurrent()} disabled={currentInFlight}>
            <Icon name="arrow-path" size={16} cls={currentInFlight ? 'animate-spin' : ''} />
            {$t('dashboard.retryStatus')}
          </button>
        </div>
      {/if}

      {#if total === 0}
      <div class="rounded text-center py-16 space-y-4"
        style="border: 1px solid var(--border-color); background-color: rgb(var(--card));">
        <div class="w-12 h-12 rounded flex items-center justify-center mx-auto"
          style="background: color-mix(in srgb, var(--color-primary) 10%, transparent); color: var(--color-primary)">
          <Icon name="signal" size={22} />
        </div>
        <div>
          <p class="text-base font-semibold tracking-tight" style="color: rgb(var(--text))">{$t('dashboard.noMonitors')}</p>
          <p class="text-sm mt-1 max-w-xs mx-auto" style="color: rgb(var(--text-muted))">
            {$t('dashboard.noMonitorsDesc')}
          </p>
        </div>
        <a href="/monitors/new" class="btn-primary inline-flex">
          <Icon name="plus" size={14} />
          {$t('dashboard.createMonitor')}
        </a>
      </div>
      {:else}
      {#if pending > 0}
        <div class="state-reveal flex items-center gap-2 px-4 py-3 rounded text-sm"
          style="background: rgb(var(--pending-bg)); color: var(--pending-fg); border: 1px solid var(--border-color)">
          <Icon name="clock" size={14} />
          <span class="flex-1">{@html pendingLabel}</span>
        </div>
      {/if}

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,.65fr)]">
        <section class="space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-semibold" style="color: rgb(var(--text))">{$t('dashboard.needsAttention')}</h2>
            <a href="/monitors" class="btn-ghost">{$t('dashboard.viewMonitors')}</a>
          </div>
          {#if down + pending + stale > attention.length}
            <p class="text-sm" style="color: rgb(var(--text-muted))">{$t('dashboard.attentionLimit')}</p>
          {/if}
          {#if attention.length > 0}
            {#each attention as monitor (monitor.id)}
              <MonitorCard {monitor} uptime={uptimes[monitor.id] ?? null} />
            {/each}
          {:else}
            <div class="all-clear-panel card flex items-center gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-full badge-up">
                <Icon name="check-circle" size={20} />
              </div>
              <div>
                <p class="font-semibold" style="color: rgb(var(--text))">{up > 0 ? $t('dashboard.allOperational') : $t('status.noActive')}</p>
                <p class="text-sm" style="color: rgb(var(--text-muted))">{$t('dashboard.noActiveIssues')}</p>
              </div>
            </div>
          {/if}
        </section>

        <section class="space-y-3">
          <h2 class="text-lg font-semibold" style="color: rgb(var(--text))">{$t('dashboard.uptimeWatchlist')}</h2>
          {#if analyticsState === 'error'}
            <div class="alert state-reveal flex-col text-sm" role="status"
              style="background: rgb(var(--warning-bg)); color: var(--warning-fg)">
              <Icon name="exclamation-triangle" size={18} />
              <div class="min-w-0 flex-1">
                <p class="font-semibold">{$t('dashboard.analyticsFailedTitle')}</p>
                <p class="mt-0.5">{analyticsError}</p>
              </div>
              <button class="btn-outline w-full shrink-0 text-inherit" on:click={() => loadAnalytics(true)} disabled={analyticsInFlight}>
                <Icon name="arrow-path" size={16} cls={analyticsInFlight ? 'animate-spin' : ''} />
                {$t('dashboard.retryUptime')}
              </button>
            </div>
          {/if}
          {#if analyticsState === 'loading' && !hasAnalyticsData}
            <div class="card flex items-center gap-3 text-sm" aria-live="polite" aria-busy="true">
              <Icon name="arrow-path" size={17} cls="animate-spin" />
              <span style="color: rgb(var(--text-muted))">{$t('dashboard.loadingUptime')}</span>
            </div>
          {:else if hasAnalyticsData}
            <div class="card divide-y p-0">
              {#each watchlist as monitor (monitor.id)}
                <a href="/monitors/{monitor.id}" class="watchlist-row flex min-h-14 items-center justify-between gap-3 px-4 py-3">
                  <span class="min-w-0 truncate text-sm font-medium" style="color: rgb(var(--text))">{monitor.name}</span>
                  <span class="shrink-0 font-mono text-sm" style="color: rgb(var(--text-muted))">
                    {uptimes[monitor.id] === null || uptimes[monitor.id] === undefined ? '—' : `${uptimes[monitor.id]!.toFixed(2)}%`}
                  </span>
                </a>
              {:else}
                <p class="p-4 text-sm" style="color: rgb(var(--text-muted))">{$t('dashboard.noPerformanceData')}</p>
              {/each}
            </div>
          {/if}
        </section>
      </div>
      {/if}
    {/if}

    <OperationsPanel />
  </div>
</div>

<style>
  .freshness-receipt {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .freshness-trace {
    width: 1.5rem;
    height: 0.75rem;
    flex: none;
    overflow: visible;
    color: var(--color-primary);
  }

  .freshness-trace path {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1;
    animation: status-receipt 480ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .state-reveal {
    animation: state-reveal 220ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes status-receipt {
    from {
      stroke-dashoffset: 1;
      opacity: 0.55;
    }
    to {
      stroke-dashoffset: 0;
      opacity: 1;
    }
  }

  @keyframes state-reveal {
    from {
      clip-path: inset(0 0 18% 0 round 0.75rem);
      opacity: 0.72;
    }
    to {
      clip-path: inset(0 0 0 0 round 0.75rem);
      opacity: 1;
    }
  }
</style>
