<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from 'svelte/store'
  import { api, type Monitor } from '$lib/api'
  import { t, locale, nMonitors } from '$lib/i18n'
  import { formatRelative } from '$lib/utils'
  import Icon from '$lib/components/Icon.svelte'
  import PageLoader from '$lib/components/PageLoader.svelte'
  import StatusBadge from '$lib/components/StatusBadge.svelte'
  import MonitorCard from '$lib/components/MonitorCard.svelte'

  let items: Monitor[] = []
  let loading = true
  let error = ''
  let filter = ''
  let typeFilter: 'all' | Monitor['type'] = 'all'
  let statusFilter: 'all' | Monitor['lastStatus'] = 'all'
  let activeFilter: 'all' | 'true' | 'false' = 'all'
  let sort: 'name' | 'status' | 'type' | 'checked' | 'updated' = 'updated'
  let direction: 'asc' | 'desc' = 'desc'
  let page = 1
  let pageSize = 25
  let total = 0
  let totalPages = 1
  let selected = new Set<string>()
  let searchTimer: ReturnType<typeof setTimeout>

  async function load() {
    loading = true
    try {
      const result = await api.monitors.search({
        page, pageSize, search: filter, type: typeFilter, status: statusFilter,
        active: activeFilter, sort, direction,
      })
      items = result.items
      total = result.total
      totalPages = result.totalPages
      error = ''
      selected = new Set([...selected].filter(id => items.some(item => item.id === id)))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  function scheduleLoad(resetPage = true) {
    if (resetPage) page = 1
    clearTimeout(searchTimer)
    searchTimer = setTimeout(load, 250)
  }

  function toggleSelection(id: string) {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    selected = next
  }

  function togglePageSelection() {
    selected = selected.size === items.length
      ? new Set()
      : new Set(items.map(item => item.id))
  }

  async function bulk(action: 'pause' | 'resume' | 'delete') {
    const ids = [...selected]
    if (ids.length === 0) return
    if (action === 'delete' && !confirm(get(t)('monitors.bulkDeleteConfirm').replace('{n}', String(ids.length)))) return
    try {
      await api.monitors.bulk(ids, action)
      selected = new Set()
      await load()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  function changeSort(next: typeof sort) {
    if (sort === next) direction = direction === 'asc' ? 'desc' : 'asc'
    else {
      sort = next
      direction = next === 'name' ? 'asc' : 'desc'
    }
    load()
  }

  async function deleteMonitor(monitor: Monitor) {
    if (!confirm(get(t)('confirm.deleteMonitor', { name: monitor.name }))) return
    await api.monitors.delete(monitor.id)
    await load()
  }

  onMount(load)
  $: configuredLabel = `${nMonitors($locale, total)} ${$t(total === 1 ? 'monitors.configuredOne' : 'monitors.configuredMany')}`
</script>

<svelte:head><title>{$t('monitors.heading')} - Pingflare</title></svelte:head>

<div class="page-shell space-y-6">
  <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p class="section-title">{$t('nav.monitors')}</p>
      <h1 class="mt-2 text-2xl font-semibold tracking-tight md:text-3xl" style="color: rgb(var(--text))">
        {$t('monitors.heading')}
      </h1>
      <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">{configuredLabel}</p>
    </div>
    <a href="/monitors/new" class="btn-primary">
      <Icon name="plus" size={17} /> {$t('monitors.addMonitor')}
    </a>
  </header>

  {#if error}
    <div class="alert" role="alert" style="background: rgb(var(--danger-bg)); color: var(--danger-fg)">
      <Icon name="exclamation-triangle" size={18} />
      <span class="flex-1">{error}</span>
      <button class="btn-ghost icon-button" aria-label="Dismiss error" on:click={() => error = ''}>
        <Icon name="x-mark" size={18} />
      </button>
    </div>
  {/if}

  <section class="card space-y-4" aria-label={$t('monitors.filters')}>
    <div class="grid gap-3 md:grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(9rem,auto))]">
      <label>
        <span class="sr-only">{$t('monitors.searchPlaceholder')}</span>
        <input class="input" type="search" bind:value={filter}
          on:input={() => scheduleLoad()} placeholder={$t('monitors.searchPlaceholder')} />
      </label>
      <select class="input" bind:value={typeFilter} on:change={() => scheduleLoad()}>
        <option value="all">{$t('monitors.allTypes')}</option>
        <option value="http">{$t('monitors.http')}</option>
        <option value="heartbeat">{$t('monitors.heartbeat')}</option>
        <option value="agent">{$t('monitors.agent')}</option>
        <option value="dns">{$t('monitors.dns')}</option>
        <option value="ping">{$t('monitors.ping')}</option>
      </select>
      <select class="input" bind:value={statusFilter} on:change={() => scheduleLoad()}>
        <option value="all">{$t('monitors.allStatuses')}</option>
        <option value="up">{$t('monitors.up')}</option>
        <option value="down">{$t('monitors.down')}</option>
        <option value="pending">{$t('monitors.pending')}</option>
      </select>
      <select class="input" bind:value={activeFilter} on:change={() => scheduleLoad()}>
        <option value="all">{$t('monitors.allActivity')}</option>
        <option value="true">{$t('common.active')}</option>
        <option value="false">{$t('common.disabled')}</option>
      </select>
    </div>

    {#if selected.size > 0}
      <div class="flex flex-wrap items-center gap-2 rounded-lg p-2"
        style="background: var(--color-primary-soft); color: var(--color-primary)">
        <strong class="px-2 text-sm">{$t('monitors.selected').replace('{n}', String(selected.size))}</strong>
        <button class="btn-outline" on:click={() => bulk('resume')}><Icon name="play" size={16} /> {$t('monitors.resume')}</button>
        <button class="btn-outline" on:click={() => bulk('pause')}><Icon name="pause" size={16} /> {$t('monitors.pause')}</button>
        <button class="btn-danger" on:click={() => bulk('delete')}><Icon name="trash" size={16} /> {$t('common.delete')}</button>
      </div>
    {/if}
  </section>

  {#if loading}
    <PageLoader />
  {:else if items.length === 0}
    <div class="card py-14 text-center">
      <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-xl"
        style="background: var(--color-primary-soft); color: var(--color-primary)">
        <Icon name="signal" size={24} />
      </div>
      <h2 class="mt-4 font-semibold" style="color: rgb(var(--text))">{$t('monitors.noMatch')}</h2>
      <p class="mx-auto mt-1 max-w-md text-sm" style="color: rgb(var(--text-muted))">{$t('monitors.clearFiltersHint')}</p>
    </div>
  {:else}
    <div class="hidden overflow-hidden rounded-xl border lg:block" style="background: rgb(var(--card))">
      <table class="w-full border-collapse text-left text-sm">
        <thead style="background: rgb(var(--bg-subtle)); color: rgb(var(--text-muted))">
          <tr>
            <th class="w-12 p-3">
              <input type="checkbox" aria-label={$t('monitors.selectPage')} checked={selected.size === items.length}
                on:change={togglePageSelection} class="h-5 w-5 accent-primary" />
            </th>
            <th class="p-3"><button class="min-h-11 font-semibold" on:click={() => changeSort('name')}>{$t('common.name')}</button></th>
            <th class="p-3"><button class="min-h-11 font-semibold" on:click={() => changeSort('status')}>{$t('monitor.colStatus')}</button></th>
            <th class="p-3"><button class="min-h-11 font-semibold" on:click={() => changeSort('type')}>{$t('monitors.type')}</button></th>
            <th class="p-3"><button class="min-h-11 font-semibold" on:click={() => changeSort('checked')}>{$t('monitor.lastCheck')}</button></th>
            <th class="p-3 text-right">{$t('monitors.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {#each items as monitor (monitor.id)}
            <tr class="border-t hover:bg-[rgb(var(--bg-subtle))]">
              <td class="p-3">
                <input type="checkbox" aria-label={$t('monitors.selectNamed').replace('{name}', monitor.name)}
                  checked={selected.has(monitor.id)} on:change={() => toggleSelection(monitor.id)}
                  class="h-5 w-5 accent-primary" />
              </td>
              <td class="p-3">
                <a href="/monitors/{monitor.id}" class="block min-h-11 py-1 hover:text-[var(--color-primary)]">
                  <span class="block font-semibold" style="color: rgb(var(--text))">{monitor.name}</span>
                  <span class="block max-w-xs truncate text-xs" style="color: rgb(var(--text-muted))">
                    {monitor.url ?? monitor.dnsHostname ?? monitor.type}
                  </span>
                </a>
              </td>
              <td class="p-3"><StatusBadge status={monitor.lastStatus} /></td>
              <td class="p-3 uppercase" style="color: rgb(var(--text-muted))">{monitor.type}</td>
              <td class="p-3" style="color: rgb(var(--text-muted))">{formatRelative(monitor.lastCheckedAt, $locale)}</td>
              <td class="p-3">
                <div class="flex justify-end gap-1">
                  <a href="/monitors/{monitor.id}/edit" class="btn-ghost icon-button" aria-label={$t('monitors.edit')}>
                    <Icon name="pencil" size={17} />
                  </a>
                  <button class="btn-ghost icon-button" aria-label={$t('monitors.delete')} on:click={() => deleteMonitor(monitor)}>
                    <Icon name="trash" size={17} />
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="space-y-3 lg:hidden">
      {#each items as monitor (monitor.id)}
        <div class="mobile-monitor-row relative">
          <label class="absolute left-3 top-3 z-10 flex h-11 w-11 items-center justify-center">
            <input type="checkbox" aria-label={$t('monitors.selectNamed').replace('{name}', monitor.name)}
              checked={selected.has(monitor.id)} on:change={() => toggleSelection(monitor.id)}
              class="h-5 w-5 accent-primary" />
          </label>
          <MonitorCard {monitor} />
        </div>
      {/each}
    </div>

    <nav class="flex flex-col items-center justify-between gap-3 sm:flex-row" aria-label={$t('monitors.pagination')}>
      <p class="text-sm" style="color: rgb(var(--text-muted))">
        {$t('monitors.pageSummary').replace('{page}', String(page)).replace('{pages}', String(totalPages)).replace('{total}', String(total))}
      </p>
      <div class="flex gap-2">
        <button class="btn-outline" disabled={page <= 1} on:click={() => { page -= 1; load() }}>{$t('monitor.prevPage')}</button>
        <button class="btn-outline" disabled={page >= totalPages} on:click={() => { page += 1; load() }}>{$t('monitor.nextPage')}</button>
      </div>
    </nav>
  {/if}
</div>

<style>
  :global(.mobile-monitor-row > a) {
    padding-left: 4rem !important;
  }
</style>
