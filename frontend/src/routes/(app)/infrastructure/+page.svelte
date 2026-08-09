<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { api } from '$lib/api'
  import type {
    InfrastructureNode,
    InfrastructureNodeState,
    InfrastructureOverview,
  } from '$lib/api'
  import { locale } from '$lib/i18n'
  import { formatRelative } from '$lib/utils'
  import { describeInfrastructureSignal } from '$lib/infrastructure'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import PageLoader from '$lib/components/PageLoader.svelte'

  let overview: InfrastructureOverview | null = null
  let loading = true
  let error = ''
  let inFlight = false
  let destroyed = false
  let refreshTimer: ReturnType<typeof setTimeout>

  const stateLabels: Record<InfrastructureNodeState, string> = {
    healthy: 'Healthy',
    warning: 'Watch',
    critical: 'Critical',
    stale: 'Stale',
    pending: 'Pending',
    paused: 'Paused',
  }

  const stateClasses: Record<InfrastructureNodeState, string> = {
    healthy: 'badge-up',
    warning: 'badge-warning',
    critical: 'badge-down',
    stale: 'badge-down',
    pending: 'badge-pending',
    paused: 'badge-pending',
  }

  function metricTone(value: number, threshold: number | null): string {
    if (threshold === null) return ''
    if (value > threshold) return 'text-red-500'
    if (value >= threshold * 0.8) return 'text-yellow-600 dark:text-yellow-400'
    return ''
  }

  async function loadOverview() {
    if (inFlight || (typeof document !== 'undefined' && document.hidden)) return
    inFlight = true
    try {
      overview = await api.infrastructure.overview()
      error = ''
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
      inFlight = false
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer)
    if (!destroyed) {
      refreshTimer = setTimeout(async () => {
        await loadOverview()
        scheduleRefresh()
      }, 60_000)
    }
  }

  function handleVisibility() {
    if (!document.hidden) {
      void loadOverview()
      scheduleRefresh()
    }
  }

  onMount(() => {
    void loadOverview().finally(scheduleRefresh)
    document.addEventListener('visibilitychange', handleVisibility)
  })

  onDestroy(() => {
    destroyed = true
    clearTimeout(refreshTimer)
    document.removeEventListener('visibilitychange', handleVisibility)
  })
</script>

<svelte:head><title>Infrastructure - Pingflare</title></svelte:head>

{#if loading && !overview}
  <PageLoader />
{:else}
  <div class="relative min-h-full">
    <HeaderPattern />
    <div class="relative mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="section-title">Fleet health</p>
          <h1 class="mt-1 text-2xl font-semibold tracking-tight md:text-3xl" style="color: rgb(var(--text))">
            Infrastructure
          </h1>
          <p class="mt-2 max-w-2xl text-sm" style="color: rgb(var(--text-muted))">
            Current server health and resource pressure. Open a node only when deeper investigation is needed.
          </p>
        </div>
        <button type="button" class="btn-outline text-xs" on:click={loadOverview} disabled={inFlight}>
          <Icon name="arrow-path" size={15} cls={inFlight ? 'animate-spin' : ''} />
          Refresh
        </button>
      </header>

      {#if error}
        <div class="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          Infrastructure data could not be refreshed. {error}
        </div>
      {/if}

      {#if overview}
        <section class="grid gap-3 sm:grid-cols-3" aria-label="Infrastructure summary">
          <div class="stat-card">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">Nodes reporting</span>
              <Icon name="server-stack" size={18} cls="text-green-500" />
            </div>
            <div class="mt-3 text-3xl font-semibold tabular-nums">{overview.summary.reporting}<span class="text-base font-normal" style="color: rgb(var(--text-muted))"> / {overview.summary.total}</span></div>
            <p class="mt-1 text-xs" style="color: rgb(var(--text-muted))">Fresh, complete agent reports</p>
          </div>
          <div class="stat-card">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">Resource pressure</span>
              <Icon name="chart-bar" size={18} cls={overview.summary.pressure > 0 ? 'text-yellow-500' : 'text-green-500'} />
            </div>
            <div class="mt-3 text-3xl font-semibold tabular-nums" class:text-yellow-500={overview.summary.pressure > 0}>{overview.summary.pressure}</div>
            <p class="mt-1 text-xs" style="color: rgb(var(--text-muted))">Near or above configured thresholds</p>
          </div>
          <div class="stat-card">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium" style="color: rgb(var(--text-muted))">Telemetry freshness</span>
              <Icon name="clock" size={18} cls={overview.summary.stale > 0 ? 'text-red-400' : 'text-green-500'} />
            </div>
            <div class="mt-3 text-3xl font-semibold tabular-nums" class:text-red-400={overview.summary.stale > 0}>{overview.summary.stale}</div>
            <p class="mt-1 text-xs" style="color: rgb(var(--text-muted))">Nodes with stale agent data</p>
          </div>
        </section>

        {#if overview.nodes.length === 0}
          <section class="card flex min-h-64 flex-col items-center justify-center text-center">
            <Icon name="server-stack" size={32} cls="mb-3 text-primary" />
            <h2 class="text-base font-semibold">No server agents yet</h2>
            <p class="mt-2 max-w-md text-sm" style="color: rgb(var(--text-muted))">
              Create an Agent monitor to start collecting server health, CPU, RAM, and disk usage.
            </p>
            <a href="/monitors/new?type=agent" class="btn-primary mt-5">Add server agent</a>
          </section>
        {:else}
          <section class="card">
            <div class="mb-4 flex items-center justify-between">
              <div>
                <p class="section-title">Priority</p>
                <h2 class="mt-1 text-lg font-semibold">Needs attention</h2>
              </div>
              <span class="text-xs" style="color: rgb(var(--text-muted))">Top 5 only</span>
            </div>
            {#if overview.issues.length === 0}
              <div class="flex items-center gap-3 rounded-lg p-4" style="background: rgb(var(--success-bg))">
                <Icon name="check-circle" size={20} cls="text-green-500" />
                <div>
                  <p class="text-sm font-semibold">All reporting nodes look healthy</p>
                  <p class="mt-0.5 text-xs" style="color: rgb(var(--text-muted))">No stale telemetry or resource pressure detected.</p>
                </div>
              </div>
            {:else}
              <div class="divide-y" style="border-color: var(--border-color)">
                {#each overview.issues as node}
                  <a href="/monitors/{node.id}" class="flex min-h-14 items-center gap-3 py-3 transition-opacity hover:opacity-80" aria-label="{node.name}: {describeInfrastructureSignal(node.strongestSignal, $locale)}">
                    <span class="badge {stateClasses[node.state]}">{stateLabels[node.state]}</span>
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-semibold">{node.name}</p>
                      <p class="mt-0.5 text-xs leading-4" style="color: rgb(var(--text-muted))">{describeInfrastructureSignal(node.strongestSignal, $locale)}</p>
                    </div>
                    <Icon name="arrow-up-right" size={15} cls="shrink-0" />
                  </a>
                {/each}
              </div>
            {/if}
          </section>

          <section class="card overflow-hidden p-0">
            <div class="flex items-center justify-between px-5 py-4">
              <div>
                <p class="section-title">Fleet</p>
                <h2 class="mt-1 text-lg font-semibold">Server nodes</h2>
              </div>
              <span class="text-xs" style="color: rgb(var(--text-muted))">Updated {formatRelative(overview.generatedAt, $locale)}</span>
            </div>

            <div class="hidden overflow-x-auto md:block">
              <table class="w-full text-sm">
                <thead>
                  <tr style="border-top: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); background: rgb(var(--bg-subtle))">
                    <th class="px-5 py-3 text-left text-xs font-medium" style="color: rgb(var(--text-muted))">Node</th>
                    <th class="px-3 py-3 text-left text-xs font-medium" style="color: rgb(var(--text-muted))">State</th>
                    <th class="px-3 py-3 text-right text-xs font-medium" style="color: rgb(var(--text-muted))">CPU</th>
                    <th class="px-3 py-3 text-right text-xs font-medium" style="color: rgb(var(--text-muted))">RAM</th>
                    <th class="px-3 py-3 text-right text-xs font-medium" style="color: rgb(var(--text-muted))">Disk</th>
                    <th class="px-5 py-3 text-right text-xs font-medium" style="color: rgb(var(--text-muted))">Last report</th>
                  </tr>
                </thead>
                <tbody>
                  {#each overview.nodes as node}
                    <tr class="transition-colors hover:bg-[rgb(var(--bg-subtle))]" style="border-bottom: 1px solid var(--border-color)">
                      <td class="px-5 py-3">
                        <a href="/monitors/{node.id}" class="font-semibold hover:text-primary">{node.name}</a>
                        <p class="mt-0.5 max-w-xs text-xs leading-4" style="color: rgb(var(--text-muted))">{describeInfrastructureSignal(node.strongestSignal, $locale)}</p>
                      </td>
                      <td class="px-3 py-3"><span class="badge {stateClasses[node.state]}">{stateLabels[node.state]}</span></td>
                      <td class="px-3 py-3 text-right font-mono tabular-nums {node.metrics ? metricTone(node.metrics.cpu, node.thresholds.cpu) : ''}">{node.metrics ? `${node.metrics.cpu}%` : '—'}</td>
                      <td class="px-3 py-3 text-right font-mono tabular-nums {node.metrics ? metricTone(node.metrics.ram, node.thresholds.ram) : ''}">{node.metrics ? `${node.metrics.ram}%` : '—'}</td>
                      <td class="px-3 py-3 text-right font-mono tabular-nums {node.metrics ? metricTone(node.metrics.disk, node.thresholds.disk) : ''}">{node.metrics ? `${node.metrics.disk}%` : '—'}</td>
                      <td class="px-5 py-3 text-right text-xs tabular-nums" style="color: rgb(var(--text-muted))">{formatRelative(node.lastCheckedAt, $locale)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <div class="divide-y md:hidden" style="border-top: 1px solid var(--border-color); border-color: var(--border-color)">
              {#each overview.nodes as node}
                <a href="/monitors/{node.id}" class="block p-4">
                  <div class="flex items-center justify-between gap-3">
                    <span class="truncate text-sm font-semibold">{node.name}</span>
                    <span class="badge {stateClasses[node.state]}">{stateLabels[node.state]}</span>
                  </div>
                  <p class="mt-1 text-xs leading-4" style="color: rgb(var(--text-muted))">{describeInfrastructureSignal(node.strongestSignal, $locale)}</p>
                  <div class="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <span>CPU <strong class="font-mono">{node.metrics ? `${node.metrics.cpu}%` : '—'}</strong></span>
                    <span>RAM <strong class="font-mono">{node.metrics ? `${node.metrics.ram}%` : '—'}</strong></span>
                    <span>Disk <strong class="font-mono">{node.metrics ? `${node.metrics.disk}%` : '—'}</strong></span>
                  </div>
                  <p class="mt-2 text-xs" style="color: rgb(var(--text-muted))">Last report {formatRelative(node.lastCheckedAt, $locale)}</p>
                </a>
              {/each}
            </div>
          </section>

          {#if overview.truncated}
            <p class="text-xs" style="color: rgb(var(--text-muted))">
              Showing the first 200 server agents. Use Monitors for the complete inventory.
            </p>
          {/if}
        {/if}
      {/if}
    </div>
  </div>
{/if}
