<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/stores'
  import { api } from '$lib/api'
  import { t, locale } from '$lib/i18n'
  import { get } from 'svelte/store'
  import type {
    AgentMetricHistory,
    AgentMetricRange,
    Monitor,
    StatusLog,
    Incident,
    DailyUptime,
  } from '$lib/api'
  import StatusBadge from '$lib/components/StatusBadge.svelte'
  import UptimeChart from '$lib/components/UptimeChart.svelte'
  import ResponseTimeChart from '$lib/components/ResponseTimeChart.svelte'
  import AgentResourceChart from '$lib/components/AgentResourceChart.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import PageLoader from '$lib/components/PageLoader.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'
  import { formatRelative, formatDuration, formatTs, formatUptime, parseTags } from '$lib/utils'

  function logMsg(msg: string | null): string {
    if (!msg) return ''
    if (msg.startsWith('notify.')) return $t(msg as Parameters<typeof $t>[0])
    return msg
  }

  $: id = $page.params.id as string

  let monitor: Monitor | null = null
  let logs: StatusLog[] = []
  let recentLogs: StatusLog[] = []
  let incidents: Incident[] = []
  let daily: DailyUptime[] = []
  let uptime30: number | null = null
  let uptime1: number | null = null
  let uptime7: number | null = null
  let uptime90: number | null = null
  let hbToken: string | null = null
  let checkCount = 0
  let loading = true
  let currentError = ''
  let analyticsError = ''
  let actionError = ''
  let error = ''
  let currentTicker: ReturnType<typeof setTimeout>
  let analyticsTicker: ReturnType<typeof setTimeout>
  let currentInFlight = false
  let analyticsInFlight = false
  let destroyed = false
  let copied = false
  let running = false
  let logsPage = 0
  let avgResponseTime: number | null = null
  const tabs = ['overview', 'performance', 'incidents', 'logs', 'configuration'] as const
  type DetailTab = typeof tabs[number]
  $: requestedTab = $page.url.searchParams.get('tab')
  $: activeTab = tabs.includes(requestedTab as DetailTab) ? requestedTab as DetailTab : 'overview'
  let metrics: { cpu: number; ram: number; disk: number; docker?: Array<{ name: string; status: string; health?: string }> } | null = null
  let metricRange: AgentMetricRange = '24h'
  let metricHistory: AgentMetricHistory | null = null
  let metricHistoryLoading = false
  let metricHistoryError = ''
  let lastMetricRequest = ''

  $: {
    try {
      metrics = monitor?.type === 'agent' && monitor.lastMetrics
        ? JSON.parse(monitor.lastMetrics)
        : null
    } catch {
      metrics = null
    }
  }

  async function loadMetricHistory(range: AgentMetricRange) {
    metricHistoryLoading = true
    metricHistoryError = ''
    try {
      metricHistory = await api.monitors.metricHistory(id, range)
    } catch (e) {
      metricHistoryError = String(e)
    } finally {
      metricHistoryLoading = false
    }
  }

  $: if (monitor?.type === 'agent' && activeTab === 'performance') {
    const requestKey = `${id}:${metricRange}`
    if (requestKey !== lastMetricRequest) {
      lastMetricRequest = requestKey
      void loadMetricHistory(metricRange)
    }
  }

  async function loadCurrent() {
    if (currentInFlight || (typeof document !== 'undefined' && document.hidden)) return
    currentInFlight = true
    try {
      monitor = await api.monitors.get(id)
      ;[recentLogs, incidents] = await Promise.all([
        api.monitors.recentLogs(id, 200),
        api.monitors.incidents(id),
      ])
      const since24h = Math.floor(Date.now() / 1000) - 86400
      logs = recentLogs.filter((log) => log.checkedAt >= since24h)
      if ((monitor?.type === 'heartbeat' || monitor?.type === 'agent') && !hbToken) {
        const tok = await api.monitors.hbToken(id)
        hbToken = tok.token
      }
      currentError = ''
    } catch (e) {
      currentError = String(e)
    } finally {
      currentInFlight = false
    }
  }

  async function loadAnalytics() {
    if (analyticsInFlight || (typeof document !== 'undefined' && document.hidden)) return
    analyticsInFlight = true
    try {
      const analytics = await api.monitors.analytics(id, 90)
      daily = analytics.daily
      uptime1 = analytics.uptimes['1']
      uptime7 = analytics.uptimes['7']
      uptime30 = analytics.uptimes['30']
      uptime90 = analytics.uptimes['90']
      checkCount = analytics.count
      avgResponseTime = analytics.avgResponseMs
      analyticsError = ''
    } catch (e) {
      analyticsError = String(e)
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
    actionError = ''
    try {
      const result = await api.cron.run()
      if (result.skippedBecauseLeased) {
        actionError = $t('dashboard.checksAlreadyRunning')
        return
      }
      await Promise.all([loadCurrent(), loadAnalytics()])
    } catch (e) {
      actionError = String(e)
    } finally {
      running = false
    }
  }

  async function resetStats() {
    if (!confirm(get(t)('monitor.resetConfirm'))) return
    try {
      await api.monitors.resetStats(id)
      await Promise.all([loadCurrent(), loadAnalytics()])
    } catch (e) {
      actionError = String(e)
    }
  }

  async function deleteMonitor() {
    if (!monitor) return
    if (!confirm(get(t)('monitor.deleteConfirm', { name: monitor.name }))) return
    try {
      await api.monitors.delete(id)
      goto('/monitors')
    } catch (e) {
      actionError = String(e)
    }
  }

  async function toggleActive() {
    if (!monitor) return
    const next = !monitor.active
    const msg = next ? get(t)('monitor.enableConfirm') : get(t)('monitor.disableConfirm')
    if (!confirm(msg)) return
    try {
      monitor = await api.monitors.toggleActive(id, next)
    } catch (e) {
      actionError = String(e)
    }
  }

  async function regenToken() {
    if (!confirm(get(t)('monitor.regenConfirm'))) return
    const tok = await api.monitors.regenToken(id)
    hbToken = tok.token
  }

  async function copyToken() {
    if (!hbToken) return
    await navigator.clipboard.writeText(`${location.origin}/h/${hbToken}`)
    copied = true
    setTimeout(() => copied = false, 2000)
  }

  let copiedInstall = false
  async function copyInstall() {
    if (!hbToken) return
    await navigator.clipboard.writeText(`curl -fsSL ${location.origin}/api/agent/install/${hbToken} | sudo bash`)
    copiedInstall = true
    setTimeout(() => copiedInstall = false, 2000)
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

  $: openIncidents = incidents.filter(i => !i.resolvedAt).length
  $: error = actionError || currentError || analyticsError
  $: tags = monitor ? parseTags(monitor.tags) : []

  $: headerCount = (() => { try { return Object.keys(JSON.parse(monitor?.headers ?? '{}')).length } catch { return 0 } })()
  $: protocol = monitor?.url?.startsWith('https://') ? 'HTTPS' : monitor?.url?.startsWith('http://') ? 'HTTP' : ''

  $: totalLogPages = Math.max(1, Math.ceil(recentLogs.length / 20))
  $: pagedLogs = recentLogs.slice(logsPage * 20, (logsPage + 1) * 20)
  $: { if (logsPage >= totalLogPages) logsPage = Math.max(0, totalLogPages - 1) }
</script>

<svelte:head><title>{monitor?.name ?? 'Monitor'} - Pingflare</title></svelte:head>

{#if loading}
  <PageLoader />

{:else if !monitor}
  <div class="p-6 space-y-4">
    {#if error}<p class="text-sm text-red-400">{error}</p>{/if}
    <p style="color: rgb(var(--text-muted))">{$t('monitor.notFound')}</p>
    <a href="/monitors" class="btn-primary inline-flex">{$t('monitor.back')}</a>
  </div>

{:else}
<div style="background-color: rgb(var(--bg))">

  <div class="relative overflow-hidden" style="border-bottom: 1px solid var(--border-color)">
    <HeaderPattern />
    <div class="relative px-4 py-6 md:px-8 md:py-8 max-w-7xl mx-auto">
      <a href="/monitors" class="inline-flex items-center gap-1 text-xs mb-4 transition-colors hover:text-[var(--color-primary)]"
        style="color: rgb(var(--text-muted))">{$t('monitor.back')}</a>
      <div class="flex items-start justify-between gap-4">
        <div class="flex items-start gap-3 min-w-0">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h1 class="text-xl md:text-3xl font-semibold tracking-tight" style="color: rgb(var(--text))">{monitor.name}</h1>
              <StatusBadge status={monitor.lastStatus} />
              {#if monitor.sslCheckEnabled && monitor.sslStatus !== 'unknown'}
                <span class="text-xs px-2 py-0.5 rounded font-medium {monitor.sslStatus === 'ok' ? 'text-green-600' : 'text-red-400'}"
                  style="background: {monitor.sslStatus === 'ok' ? 'rgb(34 197 94 / .1)' : 'rgb(239 68 68 / .1)'}">
                  {$t('monitor.ssl')}: {monitor.sslStatus === 'ok' ? $t('monitor.sslOk') : $t('monitor.sslError')}
                </span>
              {/if}
            </div>
            {#if monitor.url}
              <p class="text-xs font-mono mt-1 truncate max-w-xs md:max-w-none" style="color: rgb(var(--text-muted))">{monitor.url}</p>
            {:else if monitor.type === 'dns' && monitor.dnsResolverUrl}
              <p class="text-xs font-mono mt-1 truncate max-w-xs md:max-w-none" style="color: rgb(var(--text-muted))">{monitor.dnsResolverUrl}</p>
            {:else if monitor.type === 'ping' && monitor.url}
              <p class="text-xs font-mono mt-1 truncate max-w-xs md:max-w-none" style="color: rgb(var(--text-muted))">{monitor.url}</p>
            {/if}
            {#if monitor.type === 'http'}
              <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs" style="color: rgb(var(--text-muted))">
                <span>{$t('monitor.configInterval')}: {monitor.interval}s</span>
                {#if protocol}<span>{$t('monitor.configProtocol')}: {protocol}</span>{/if}
                <span>{$t('monitor.configMethod')}: {monitor.method}</span>
                <span>{$t('monitor.configTimeout')}: {monitor.timeout}s</span>
                {#if headerCount > 0}<span>{$t('monitor.configHeaders')}: {headerCount}</span>{/if}
                {#if monitor.cacheBooster}<span class="text-[var(--color-primary)]">{$t('monitor.configCacheBooster')}: ON</span>{/if}
                {#if monitor.sslCheckEnabled}<span class="text-[var(--color-primary)]">{$t('monitor.configSslCheck')}: ON</span>{/if}
              </div>
            {/if}
            {#if monitor.type === 'dns'}
              <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs" style="color: rgb(var(--text-muted))">
                <span>{$t('monitor.configInterval')}: {monitor.interval}s</span>
                {#if monitor.dnsHostname}<span>{$t('monitor.configDnsHostname')}: {monitor.dnsHostname}</span>{/if}
                {#if monitor.dnsRecordType}<span>{$t('monitor.configDnsRecordType')}: {monitor.dnsRecordType}</span>{/if}
                <span>{$t('monitor.configTimeout')}: {monitor.timeout}s</span>
                {#if monitor.dnsExpectedIp}<span class="text-[var(--color-primary)]">{$t('monitor.configDnsExpected')}: {monitor.dnsExpectedIp}</span>{/if}
              </div>
            {/if}
            {#if monitor.type === 'ping'}
              <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs" style="color: rgb(var(--text-muted))">
                <span>{$t('monitor.configInterval')}: {monitor.interval}s</span>
                <span>{$t('monitor.configTimeout')}: {monitor.timeout}s</span>
              </div>
            {/if}
            {#if tags.length > 0}
              <div class="flex gap-1.5 mt-2 flex-wrap">
                {#each tags as tag}
                  <span class="text-xs px-2 py-0.5 rounded font-medium"
                    style="background: color-mix(in srgb, var(--color-primary) 10%, transparent); color: var(--color-primary)">{tag}</span>
                {/each}
              </div>
            {/if}
          </div>
        </div>
        <div class="flex gap-2 shrink-0">
          {#if monitor.lastStatus === 'pending'}
            <button class="btn-outline text-xs" on:click={runChecks} disabled={running} title={$t('monitor.checkNow')}>
              <Icon name="arrow-path" size={14} cls={running ? 'animate-spin' : ''} />
              <span class="hidden sm:inline">{running ? $t('monitor.checking') : $t('monitor.checkNow')}</span>
            </button>
          {/if}
          <a href="/monitors/{id}/edit" class="btn-outline">
            <Icon name="pencil" size={14} />
            <span class="hidden sm:inline">{$t('monitor.edit')}</span>
          </a>
        </div>
      </div>
    </div>
  </div>

  <div class="px-4 py-5 md:px-8 md:py-8 max-w-7xl mx-auto space-y-4">

    {#if error}
      <div class="flex items-center gap-2 px-4 py-3 rounded text-sm"
        style="background: rgb(239 68 68 / .08); color: #ef4444; border: 1px solid rgb(239 68 68 / .3)">
        <Icon name="exclamation-triangle" size={14} />
        {error}
      </div>
    {/if}

    <nav class="flex gap-1 overflow-x-auto rounded-xl border p-1" aria-label={$t('monitor.detailSections')}
      style="background: rgb(var(--bg-subtle))">
      {#each tabs as tab}
        <a href="?tab={tab}" aria-current={activeTab === tab ? 'page' : undefined}
          class="min-h-11 shrink-0 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors {activeTab === tab ? 'bg-primary-solid' : ''}"
          style={activeTab !== tab ? 'color: rgb(var(--text-muted))' : ''}>
          {$t(`monitor.tab.${tab}`)}
        </a>
      {/each}
    </nav>

    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" class:hidden={activeTab !== 'overview'}>
      <div class="stat-card">
        <div class="text-xs mb-2" style="color: rgb(var(--text-muted))">{$t('monitor.uptime30d')}</div>
        <div class="text-2xl font-bold tracking-tight tabular-nums text-green-500">{formatUptime(uptime30)}</div>
      </div>
      <div class="stat-card">
        <div class="text-xs mb-2" style="color: rgb(var(--text-muted))">{$t('monitor.avgResponse90d')}</div>
        <div class="text-2xl font-bold tracking-tight tabular-nums" style="color: rgb(var(--text))">
          {avgResponseTime != null ? `${avgResponseTime}ms` : '-'}
        </div>
      </div>
      <div class="stat-card" style="{openIncidents > 0 ? 'border-color: rgb(239 68 68 / .45)' : ''}">
        <div class="text-xs mb-2" style="color: rgb(var(--text-muted))">{$t('monitor.openIncidents')}</div>
        <div class="text-2xl font-bold tracking-tight tabular-nums {openIncidents > 0 ? 'text-red-400' : ''}"
          style="{openIncidents === 0 ? 'color: rgb(var(--text))' : ''}">{openIncidents}</div>
      </div>
      <div class="stat-card">
        <div class="text-xs mb-2" style="color: rgb(var(--text-muted))">{$t('monitor.lastCheck')}</div>
        <div class="text-base font-semibold" style="color: rgb(var(--text))">{formatRelative(monitor.lastCheckedAt, $locale)}</div>
      </div>
      <div class="stat-card">
        <div class="text-xs mb-2" style="color: rgb(var(--text-muted))">{$t('monitor.checks90d')}</div>
        <div class="text-2xl font-bold tracking-tight tabular-nums" style="color: rgb(var(--text))">{checkCount.toLocaleString()}</div>
      </div>
    </div>

    {#if monitor.type === 'agent'}
    <div class="card" class:hidden={activeTab !== 'performance'}>
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-sm font-semibold" style="color: rgb(var(--text))">CPU and RAM history</h2>
          <p class="mt-1 text-xs" style="color: rgb(var(--text-muted))">
            Loaded only when this tab is opened. Stored as five-minute samples for 30 days.
          </p>
        </div>
        <div class="flex rounded-lg p-1" style="background: rgb(var(--bg-muted))" aria-label="History range">
          {#each ['2h', '24h', '7d', '30d'] as range}
            <button
              type="button"
              class="min-h-9 rounded-md px-3 text-xs font-semibold transition-colors"
              class:bg-primary-solid={metricRange === range}
              style={metricRange !== range ? 'color: rgb(var(--text-muted))' : ''}
              aria-pressed={metricRange === range}
              on:click={() => metricRange = range as AgentMetricRange}
            >{range}</button>
          {/each}
        </div>
      </div>
      {#if metricHistoryLoading}
        <div class="flex min-h-52 items-center justify-center gap-2 text-sm" style="color: rgb(var(--text-muted))">
          <Icon name="arrow-path" size={16} cls="animate-spin" />
          Loading resource history…
        </div>
      {:else if metricHistoryError}
        <div class="flex min-h-36 flex-col items-center justify-center gap-3 text-sm text-red-400">
          <span>Resource history could not be loaded.</span>
          <button
            type="button"
            class="btn-outline text-xs"
            on:click={() => {
              lastMetricRequest = ''
              void loadMetricHistory(metricRange)
            }}
          >Try again</button>
        </div>
      {:else if metricHistory}
        <AgentResourceChart history={metricHistory} />
      {/if}
    </div>
    {/if}

    <div class="card" class:hidden={activeTab !== 'performance'}>
      <h2 class="text-sm font-semibold mb-4" style="color: rgb(var(--text))">{$t('monitor.uptime90d')}</h2>
      <UptimeChart data={daily} />
    </div>

    <div class="card" class:hidden={activeTab !== 'performance'}>
      <h2 class="text-sm font-semibold mb-4" style="color: rgb(var(--text))">{$t('monitor.overallUptime')}</h2>
      <div class="grid grid-cols-2 sm:grid-cols-4 divide-x" style="border: 1px solid var(--border-color); margin: -1px">
        {#each [
          { label: $t('monitor.last24h'), value: uptime1 },
          { label: $t('monitor.last7d'),  value: uptime7 },
          { label: $t('monitor.last30d'), value: uptime30 },
          { label: $t('monitor.last90d'), value: uptime90 },
        ] as period, i}
          <div class="flex flex-col items-center justify-center py-5 px-3 {i > 1 ? 'col-span-1' : ''}"
            style="border-color: var(--border-color)">
            <div class="text-xs mb-1.5" style="color: rgb(var(--text-muted))">{period.label}</div>
            <div class="text-xl font-bold tabular-nums {period.value === null ? '' : period.value >= 99 ? 'text-green-500' : period.value >= 95 ? 'text-yellow-400' : 'text-red-400'}"
              style="{period.value === null ? 'color: rgb(var(--text-muted))' : ''}">
              {formatUptime(period.value)}
            </div>
          </div>
        {/each}
      </div>
    </div>

    {#if monitor.type === 'http' || monitor.type === 'dns' || monitor.type === 'ping'}
    <div class="card" class:hidden={activeTab !== 'performance'}>
      <h2 class="text-sm font-semibold mb-4" style="color: rgb(var(--text))">{$t('monitor.responseTime')}</h2>
      <ResponseTimeChart {logs} height={80} />
    </div>
    {/if}

    {#if monitor.type === 'heartbeat' && hbToken}
    <div class="card space-y-3" class:hidden={activeTab !== 'overview'}>
      <div>
        <h2 class="text-sm font-semibold" style="color: rgb(var(--text))">{$t('monitor.heartbeatUrl')}</h2>
        <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">
          {$t('monitor.heartbeatUrlDesc')}
        </p>
      </div>
      <div class="flex flex-col sm:flex-row gap-2">
        <code class="flex-1 input text-xs font-mono truncate"
          style="background-color: rgb(var(--bg-subtle))">
          {location.origin}/h/{hbToken}
        </code>
        <div class="flex gap-2">
          <button class="btn-outline text-xs flex-1 sm:flex-none justify-center" on:click={copyToken}>
            <Icon name={copied ? 'check-circle' : 'clipboard'} size={14} />
            {copied ? $t('monitor.copied') : $t('monitor.copy')}
          </button>
          <button class="btn-outline text-xs flex-1 sm:flex-none justify-center" on:click={regenToken}>
            <Icon name="arrow-path" size={14} />
            {$t('monitor.regen')}
          </button>
        </div>
      </div>
    </div>
    {/if}

    {#if monitor.type === 'agent' && metrics}
    <div class="card" class:hidden={activeTab !== 'overview'}>
      <h2 class="text-sm font-semibold mb-4" style="color: rgb(var(--text))">Infrastructure Metrics</h2>
      <div class="grid grid-cols-3 divide-x text-center mb-6" style="border: 1px solid var(--border-color); margin-top: -1px; margin-bottom: -1px; margin-left: -1px; margin-right: -1px">
        <div class="py-4">
          <div class="text-xs uppercase tracking-wider mb-1" style="color: rgb(var(--text-muted))">CPU</div>
          <div class="text-2xl font-semibold" class:text-red-500={monitor.cpuThreshold && metrics.cpu > monitor.cpuThreshold}>{metrics.cpu}%</div>
        </div>
        <div class="py-4">
          <div class="text-xs uppercase tracking-wider mb-1" style="color: rgb(var(--text-muted))">RAM</div>
          <div class="text-2xl font-semibold" class:text-red-500={monitor.ramThreshold && metrics.ram > monitor.ramThreshold}>{metrics.ram}%</div>
        </div>
        <div class="py-4">
          <div class="text-xs uppercase tracking-wider mb-1" style="color: rgb(var(--text-muted))">Disk</div>
          <div class="text-2xl font-semibold" class:text-red-500={monitor.diskThreshold && metrics.disk > monitor.diskThreshold}>{metrics.disk}%</div>
        </div>
      </div>
      {#if metrics.docker && metrics.docker.length > 0}
        <h3 class="text-xs font-semibold uppercase tracking-wider mb-2 mt-4" style="color: rgb(var(--text-muted))">Docker Containers</h3>
        <div class="space-y-2">
          {#each metrics.docker as container}
            <div class="flex items-center justify-between py-2 text-sm border-b last:border-b-0" style="border-color: var(--border-color)">
              <div class="flex items-center gap-2">
                <StatusBadge status={container.status !== 'running' || container.health?.includes('unhealthy') ? 'down' : 'up'} />
                <span class="font-medium">{container.name}</span>
              </div>
              <div class="text-xs font-mono" style="color: rgb(var(--text-muted))">
                {container.status} {#if container.health}({container.health}){/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    {/if}

    {#if monitor.type === 'agent' && hbToken}
    <div class="card space-y-3 border-l-4" class:hidden={activeTab !== 'configuration'} style="border-left-color: var(--color-primary)">
      <div>
        <h2 class="text-sm font-semibold" style="color: rgb(var(--text))">Agent Installation</h2>
        <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">
          Run this command as a sudo-capable user. It installs a systemd timer, or cron as a fallback.
        </p>
      </div>
      <div class="flex flex-col sm:flex-row gap-2">
        <code class="flex-1 input text-xs font-mono truncate"
          style="background-color: rgb(var(--bg-subtle))">
          curl -fsSL {location.origin}/api/agent/install/{hbToken} | sudo bash
        </code>
        <div class="flex gap-2">
          <button class="btn-outline text-xs flex-1 sm:flex-none justify-center" on:click={copyInstall}>
            <Icon name={copiedInstall ? 'check-circle' : 'clipboard'} size={14} />
            {copiedInstall ? $t('monitor.copied') : $t('monitor.copy')}
          </button>
          <button class="btn-outline text-xs flex-1 sm:flex-none justify-center" on:click={regenToken}>
            <Icon name="arrow-path" size={14} />
            {$t('monitor.regen')}
          </button>
        </div>
      </div>
    </div>
    {/if}

    <div class="card" class:hidden={activeTab !== 'incidents'}>
      <h2 class="text-sm font-semibold mb-4" style="color: rgb(var(--text))">{$t('monitor.incidents')}</h2>
      {#if incidents.length === 0}
        <div class="flex items-center gap-2 text-sm" style="color: rgb(var(--text-muted))">
          <Icon name="check-circle" size={18} cls="text-green-500" />
          {$t('monitor.noIncidents')}
        </div>
      {:else}
        <div class="space-y-0">
          {#each incidents.slice(0, 20) as incident}
            <div class="flex items-center justify-between py-3 text-sm"
              style="border-bottom: 1px solid var(--border-color)">
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full shrink-0 {incident.resolvedAt ? 'bg-green-500' : 'bg-red-500 animate-pulse'}"></span>
                <span class="font-medium {incident.resolvedAt ? '' : 'text-red-400'}"
                  style="{incident.resolvedAt ? 'color: rgb(var(--text))' : ''}">
                  {incident.resolvedAt ? $t('monitor.resolved') : $t('monitor.ongoing')}
                </span>
                <span class="text-xs hidden sm:inline" style="color: rgb(var(--text-muted))">{formatTs(incident.startedAt)}</span>
              </div>
              <span class="text-xs tabular-nums" style="color: rgb(var(--text-muted))">
                {incident.resolvedAt ? formatDuration(incident.durationSeconds) : $t('monitor.ongoingFor', { duration: formatRelative(incident.startedAt, $locale) })}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="card" class:hidden={activeTab !== 'logs'}>
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold" style="color: rgb(var(--text))">{$t('monitor.recentChecks')}</h2>
        {#if recentLogs.length > 0}
          <span class="text-xs" style="color: rgb(var(--text-muted))">
            {logsPage * 20 + 1}–{Math.min((logsPage + 1) * 20, recentLogs.length)} / {recentLogs.length}
          </span>
        {/if}
      </div>
      {#if recentLogs.length === 0}
        <p class="text-sm" style="color: rgb(var(--text-muted))">
          {$t('monitor.noLogs')} {monitor.lastStatus === 'pending' ? $t('monitor.noLogsPending') : ''}
        </p>
      {:else}
        <table class="w-full text-xs">
          <thead>
            <tr style="border-bottom: 1px solid var(--border-color)">
              <th class="text-left pb-2 pr-3 font-medium w-14" style="color: rgb(var(--text-muted))">{$t('monitor.colStatus')}</th>
              <th class="text-left pb-2 pr-3 font-medium hidden sm:table-cell w-40" style="color: rgb(var(--text-muted))">{$t('monitor.colTime')}</th>
              {#if monitor.type === 'http' || monitor.type === 'dns' || monitor.type === 'ping'}
              <th class="text-left pb-2 pr-3 font-medium hidden sm:table-cell w-24" style="color: rgb(var(--text-muted))">{$t('monitor.colResponse')}</th>
              {/if}
              <th class="text-left pb-2 font-medium" style="color: rgb(var(--text-muted))">{$t('monitor.colMessage')}</th>
            </tr>
          </thead>
          <tbody>
            {#each pagedLogs as log}
              <tr class="hover:bg-[rgb(var(--bg-muted))] transition-colors" style="border-bottom: 1px solid var(--border-color)">
                <td class="py-2.5 pr-3">
                  <span class="font-mono font-bold tabular-nums
                    {log.status === 'up' ? 'text-green-500' : log.status === 'down' ? 'text-red-400' : 'text-primary'}">
                    {log.status.toUpperCase()}
                  </span>
                </td>
                <td class="py-2.5 pr-3 hidden sm:table-cell tabular-nums" style="color: rgb(var(--text-muted))">{formatTs(log.checkedAt)}</td>
                {#if monitor.type === 'http' || monitor.type === 'dns' || monitor.type === 'ping'}
                <td class="py-2.5 pr-3 hidden sm:table-cell" style="color: rgb(var(--text-muted))">
                  <span class="inline-flex items-center gap-1.5">
                    {#if log.countryCode}
                      <span class="fi fi-{log.countryCode.toLowerCase()} shrink-0"
                        title="{log.countryCode} · {log.originIp ?? ''} · DC {log.colo}"
                        style="width:16px;height:12px;border-radius:2px"></span>
                    {/if}
                    <span class="font-mono tabular-nums">{log.responseTimeMs != null ? `${log.responseTimeMs}ms` : '—'}</span>
                  </span>
                </td>
                {/if}
                <td class="py-2.5" style="color: rgb(var(--text-muted))">
                  <span class="break-words">{logMsg(log.message)}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if totalLogPages > 1}
          <div class="flex items-center justify-between mt-3">
            <button
              class="btn-outline text-xs py-1 px-2"
              disabled={logsPage === 0}
              on:click={() => logsPage--}
            >{$t('monitor.prevPage')}</button>
            <span class="text-xs" style="color: rgb(var(--text-muted))">{logsPage + 1} / {totalLogPages}</span>
            <button
              class="btn-outline text-xs py-1 px-2"
              disabled={logsPage + 1 >= totalLogPages}
              on:click={() => logsPage++}
            >{$t('monitor.nextPage')}</button>
          </div>
        {/if}
      {/if}
    </div>

    <div class="rounded-lg overflow-hidden" class:hidden={activeTab !== 'configuration'} style="border: 1px solid rgb(239 68 68 / .35)">
      <div class="px-4 py-3" style="background: rgb(239 68 68 / .07); border-bottom: 1px solid rgb(239 68 68 / .25)">
        <h2 class="text-sm font-semibold text-red-400">{$t('monitor.dangerZone')}</h2>
      </div>
      <div class="px-4 py-4 space-y-3">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium" style="color: rgb(var(--text))">{monitor.active ? $t('monitor.disable') : $t('monitor.enable')}</p>
            <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">
              {monitor.active ? $t('monitor.disableConfirm') : $t('monitor.enableConfirm')}
            </p>
          </div>
          <button class="btn-outline text-xs shrink-0 {monitor.active ? 'text-yellow-400 hover:text-yellow-300' : 'text-green-500 hover:text-green-400'}" on:click={toggleActive}>
            <Icon name={monitor.active ? 'pause' : 'play'} size={14} />
            {monitor.active ? $t('monitor.disable') : $t('monitor.enable')}
          </button>
        </div>
        <div style="border-top: 1px solid var(--border-color)"></div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium" style="color: rgb(var(--text))">{$t('monitor.resetStats')}</p>
            <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">{$t('monitor.resetConfirm')}</p>
          </div>
          <button class="btn-outline text-xs text-red-400 hover:text-red-300 shrink-0" on:click={resetStats}>
            <Icon name="arrow-path" size={14} />
            {$t('monitor.resetStats')}
          </button>
        </div>
        <div style="border-top: 1px solid var(--border-color)"></div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium" style="color: rgb(var(--text))">{$t('monitor.deleteMonitor')}</p>
            <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">{$t('monitor.deleteConfirm', { name: monitor.name })}</p>
          </div>
          <button class="btn-outline text-xs text-red-400 hover:text-red-300 shrink-0" on:click={deleteMonitor}>
            <Icon name="trash" size={14} />
            {$t('monitor.deleteMonitor')}
          </button>
        </div>
      </div>
    </div>

  </div>
</div>
{/if}
