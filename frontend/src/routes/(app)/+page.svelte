<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { api } from '$lib/api'
  import { monitors } from '$lib/stores'
  import { t, locale, nMonitors } from '$lib/i18n'
  import MonitorCard from '$lib/components/MonitorCard.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import PageLoader from '$lib/components/PageLoader.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'

  let loading = true
  let error = ''
  let running = false
  let lastRun: Date | null = null
  let uptimes: Record<string, number | null> = {}
  let currentTicker: ReturnType<typeof setTimeout>
  let analyticsTicker: ReturnType<typeof setTimeout>
  let currentInFlight = false
  let analyticsInFlight = false
  let destroyed = false

  async function loadCurrent() {
    if (currentInFlight || (typeof document !== 'undefined' && document.hidden)) return
    currentInFlight = true
    try {
      const list = await api.monitors.list()
      monitors.set(list)
      error = ''
    } catch (e) {
      error = String(e)
    } finally {
      currentInFlight = false
    }
  }

  async function loadAnalytics() {
    if (analyticsInFlight || (typeof document !== 'undefined' && document.hidden)) return
    analyticsInFlight = true
    try {
      const summary = await api.monitors.uptimeSummary(30)
      uptimes = summary.uptimes
    } catch (e) {
      error = String(e)
    } finally {
      analyticsInFlight = false
    }
  }

  async function load() {
    await Promise.all([loadCurrent(), loadAnalytics()])
    loading = false
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
    try {
      await api.cron.run()
      lastRun = new Date()
      await load()
    } catch (e) {
      error = String(e)
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

  $: total   = $monitors.length
  $: up      = $monitors.filter(m => m.lastStatus === 'up').length
  $: down    = $monitors.filter(m => m.lastStatus === 'down').length
  $: pending = $monitors.filter(m => m.lastStatus === 'pending').length
  $: allUp   = total > 0 && down === 0 && pending === 0
  $: attention = $monitors
    .filter(m => m.lastStatus !== 'up')
    .sort((a, b) => (a.lastStatus === 'down' ? -1 : 1) - (b.lastStatus === 'down' ? -1 : 1))
  $: watchlist = $monitors
    .filter(m => m.lastStatus === 'up')
    .sort((a, b) => (uptimes[a.id] ?? 101) - (uptimes[b.id] ?? 101))
    .slice(0, 5)

  $: downLabel    = `${nMonitors($locale, down)} ${$t('dashboard.down').toLowerCase()}`
  $: pendingLabel = (() => {
    const key = pending === 1 ? 'dashboard.pendingLabelOne' : 'dashboard.pendingLabelMany'
    return $t(key, { n: nMonitors($locale, pending), action: $t('dashboard.runChecks') })
  })()
</script>

<svelte:head><title>{$t('dashboard.heading')} - Pingflare</title></svelte:head>

<div style="background-color: rgb(var(--bg))">

  <div class="relative overflow-hidden" style="border-bottom: 1px solid var(--border-color)">
    <HeaderPattern />

    <div class="relative px-4 py-6 md:px-8 md:py-8 max-w-7xl mx-auto">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {#if allUp && total > 0}
            <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded mb-2"
              style="background: rgb(34 197 94 / .1); color: #22c55e; border: 1px solid rgb(34 197 94 / .2)">
              <span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block"></span>
              {$t('dashboard.allOperational')}
            </span>
          {:else if down > 0}
            <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded mb-2"
              style="background: rgb(239 68 68 / .1); color: #ef4444; border: 1px solid rgb(239 68 68 / .2)">
              <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block"></span>
              {downLabel}
            </span>
          {/if}
          <h1 class="text-2xl md:text-3xl font-semibold tracking-tight" style="color: rgb(var(--text))">{$t('dashboard.heading')}</h1>
          <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">
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

      {#if lastRun}
        <p class="mt-2 text-xs" style="color: rgb(var(--text-muted))">
          {$t('dashboard.lastManualRun')} {lastRun.toLocaleTimeString()}
        </p>
      {/if}
    </div>
  </div>

  <div class="px-4 py-5 md:px-8 md:py-8 max-w-7xl mx-auto space-y-6">

    {#if error}
      <div class="flex items-center gap-2 px-4 py-3 rounded text-sm"
        style="background: rgb(239 68 68 / .08); color: #ef4444; border: 1px solid rgb(239 68 68 / .3)">
        <Icon name="exclamation-triangle" size={18} />
        <span class="flex-1">{error}</span>
        <button class="btn-outline p-0.5 text-inherit" on:click={() => error = ''}>×</button>
      </div>
    {/if}

    {#if total > 0 || up > 0 || down > 0 || pending > 0}
    <div class="flex flex-wrap gap-3">
      {#if total > 0}
      <div class="stat-card flex-1 min-w-36">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">{$t('dashboard.total')}</span>
          <div class="w-9 h-9 rounded flex items-center justify-center"
            style="background-color: rgb(var(--bg-muted)); color: rgb(var(--text-muted))">
            <Icon name="signal" size={18} />
          </div>
        </div>
        <div class="text-3xl font-bold tracking-tight tabular-nums" style="color: rgb(var(--text))">{total}</div>
        <div class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('dashboard.monitorsWord')}</div>
      </div>
      {/if}

      {#if up > 0}
      <div class="stat-card flex-1 min-w-36">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">{$t('dashboard.operational')}</span>
          <div class="w-9 h-9 rounded flex items-center justify-center"
            style="background: rgb(34 197 94 / .12); color: #22c55e">
            <Icon name="check-circle" size={18} />
          </div>
        </div>
        <div class="text-3xl font-bold tracking-tight tabular-nums text-green-500">{up}</div>
        <div class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('dashboard.runningFine')}</div>
      </div>
      {/if}

      {#if down > 0}
      <div class="stat-card flex-1 min-w-36" style="border-color: rgb(239 68 68 / .45)">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">{$t('dashboard.down')}</span>
          <div class="w-9 h-9 rounded flex items-center justify-center"
            style="background: rgb(239 68 68 / .12); color: #ef4444">
            <Icon name="x-circle" size={18} />
          </div>
        </div>
        <div class="text-3xl font-bold tracking-tight tabular-nums text-red-400">{down}</div>
        <div class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('dashboard.needAttention')}</div>
      </div>
      {/if}

      {#if pending > 0}
      <div class="stat-card flex-1 min-w-36">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">{$t('dashboard.pending')}</span>
          <div class="w-9 h-9 rounded flex items-center justify-center"
            style="background: rgb(var(--pending-bg)); color: var(--pending-fg)">
            <Icon name="clock" size={18} />
          </div>
        </div>
        <div class="text-3xl font-bold tracking-tight tabular-nums" style="color: var(--pending-fg)">{pending}</div>
        <div class="text-xs mt-1" style="color: rgb(var(--text-muted))">{$t('dashboard.awaitingCheck')}</div>
      </div>
      {/if}
    </div>
    {/if}

    {#if loading}
      <PageLoader />
    {:else if $monitors.length === 0}
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
        <div class="flex items-center gap-2 px-4 py-3 rounded text-sm"
          style="background: rgb(var(--pending-bg)); color: var(--pending-fg); border: 1px solid var(--border-color)">
          <Icon name="clock" size={14} />
          <span class="flex-1">{@html pendingLabel}</span>
        </div>
      {/if}

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,.65fr)]">
        <section class="space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <p class="section-title">{$t('dashboard.priority')}</p>
              <h2 class="mt-1 text-lg font-semibold" style="color: rgb(var(--text))">{$t('dashboard.needsAttention')}</h2>
            </div>
            <a href="/monitors?status=down" class="btn-ghost">{$t('dashboard.viewMonitors')}</a>
          </div>
          {#if attention.length > 0}
            {#each attention as monitor (monitor.id)}
              <MonitorCard {monitor} uptime={uptimes[monitor.id] ?? null} />
            {/each}
          {:else}
            <div class="card flex items-center gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-full badge-up">
                <Icon name="check-circle" size={20} />
              </div>
              <div>
                <p class="font-semibold" style="color: rgb(var(--text))">{$t('dashboard.allOperational')}</p>
                <p class="text-sm" style="color: rgb(var(--text-muted))">{$t('dashboard.noActiveIssues')}</p>
              </div>
            </div>
          {/if}
        </section>

        <section class="space-y-3">
          <div>
            <p class="section-title">{$t('dashboard.performance')}</p>
            <h2 class="mt-1 text-lg font-semibold" style="color: rgb(var(--text))">{$t('dashboard.uptimeWatchlist')}</h2>
          </div>
          <div class="card divide-y p-0">
            {#each watchlist as monitor (monitor.id)}
              <a href="/monitors/{monitor.id}" class="flex min-h-14 items-center justify-between gap-3 px-4 py-3 hover:bg-[rgb(var(--bg-subtle))]">
                <span class="min-w-0 truncate text-sm font-medium" style="color: rgb(var(--text))">{monitor.name}</span>
                <span class="shrink-0 font-mono text-sm" style="color: rgb(var(--text-muted))">
                  {uptimes[monitor.id] === null || uptimes[monitor.id] === undefined ? '—' : `${uptimes[monitor.id]!.toFixed(2)}%`}
                </span>
              </a>
            {:else}
              <p class="p-4 text-sm" style="color: rgb(var(--text-muted))">{$t('dashboard.noPerformanceData')}</p>
            {/each}
          </div>
        </section>
      </div>
    {/if}

  </div>
</div>
