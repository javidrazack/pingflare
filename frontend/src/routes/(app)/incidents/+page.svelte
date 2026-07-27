<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/api'
  import { t } from '$lib/i18n'
  import { get } from 'svelte/store'
  import type {
    DetectedIncident,
    IncidentImpact,
    IncidentReport,
    IncidentStatus,
    IncidentVisibility,
    Monitor,
  } from '$lib/api'
  import Icon from '$lib/components/Icon.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'

  let incidents: IncidentReport[] = []
  let detectedIncidents: DetectedIncident[] = []
  let allMonitors: Monitor[] = []
  let loading = true
  let error = ''

  let showCreate = false
  let createTitle = ''
  let createStatus: IncidentStatus = 'investigating'
  let createMessage = ''
  let createMonitorIds: string[] = []
  let createEventIds: string[] = []
  let createVisibility: IncidentVisibility = 'published'
  let createImpact: IncidentImpact = 'minor'
  let creating = false
  let createError = ''

  let updatingIncident: IncidentReport | null = null
  let updateMessage = ''
  let updateStatus: IncidentStatus = 'investigating'
  let updating = false
  let updateError = ''
  let activeView: 'detected' | 'reported' = 'detected'

  onMount(async () => {
    try {
      ;[incidents, detectedIncidents, allMonitors] = await Promise.all([
        api.incidents.list(),
        api.incidents.detected(),
        api.monitors.list(),
      ])
    } catch (e) { error = String(e) }
    finally { loading = false }
  })

  async function create() {
    creating = true; createError = ''
    try {
      await api.incidents.create({
        title: createTitle, status: createStatus,
        message: createMessage || undefined,
        monitorIds: createMonitorIds,
        eventIds: createEventIds,
        visibility: createVisibility,
        impact: createImpact,
      })
      ;[incidents, detectedIncidents] = await Promise.all([api.incidents.list(), api.incidents.detected()])
      showCreate = false
      createTitle = ''; createMessage = ''; createMonitorIds = []; createEventIds = []
      activeView = 'reported'
    } catch (e) { createError = String(e) }
    finally { creating = false }
  }

  function openUpdate(inc: IncidentReport) {
    updatingIncident = inc
    updateMessage = ''
    updateStatus = inc.status === 'resolved' ? 'resolved' : 'monitoring'
    updateError = ''
    showCreate = false
  }

  async function addUpdate() {
    if (!updatingIncident) return
    updating = true; updateError = ''
    try {
      await api.incidents.addUpdate(updatingIncident.id, updateMessage, updateStatus)
      incidents = await api.incidents.list()
      updatingIncident = null
    } catch (e) { updateError = String(e) }
    finally { updating = false }
  }

  async function remove(inc: IncidentReport) {
    if (!confirm(get(t)('confirm.deleteIncident', { name: inc.title }))) return
    try {
      await api.incidents.delete(inc.id)
      incidents = incidents.filter(i => i.id !== inc.id)
    } catch (e) { error = String(e) }
  }

  function toggleMonitor(id: string) {
    createMonitorIds = createMonitorIds.includes(id)
      ? createMonitorIds.filter(m => m !== id)
      : [...createMonitorIds, id]
  }

  function monitorName(id: string): string {
    return allMonitors.find(m => m.id === id)?.name ?? id
  }

  function formatDate(ts: number): string {
    return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }

  function reportDetected(event: DetectedIncident) {
    createTitle = `${event.monitorName} service disruption`
    createStatus = event.resolvedAt ? 'resolved' : 'investigating'
    createMessage = event.resolvedAt
      ? 'Service has recovered. We are reviewing the event.'
      : 'We are investigating an interruption affecting this service.'
    createMonitorIds = [event.monitorId]
    createEventIds = [event.id]
    createVisibility = 'draft'
    createImpact = 'minor'
    showCreate = true
    updatingIncident = null
    activeView = 'detected'
  }

  function statusCls(s: IncidentStatus): string {
    return {
      investigating: 'text-red-400 bg-red-500/10 border-red-500/20',
      identified:    'text-orange-400 bg-orange-500/10 border-orange-500/20',
      monitoring:    'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
      resolved:      'text-green-400 bg-green-500/10 border-green-500/20',
    }[s] ?? ''
  }

  const STATUSES: IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved']

  function tIncidentStatus(s: string): string {
    return $t(('incidentStatus.' + s) as Parameters<typeof $t>[0])
  }

  $: showAnyForm = showCreate || updatingIncident !== null
</script>

<svelte:head><title>{$t('incidents.heading')} - Pingflare</title></svelte:head>

<div style="background-color: rgb(var(--bg))">

  <div class="relative overflow-hidden" style="border-bottom: 1px solid var(--border-color)">
    <HeaderPattern />
    <div class="relative px-4 py-6 md:px-8 md:py-8 max-w-5xl mx-auto flex items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl md:text-3xl font-semibold tracking-tight" style="color: rgb(var(--text))">{$t('incidents.heading')}</h1>
        <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">
          {$t('incidents.subtitle')}
        </p>
      </div>
      <button class="btn-primary shrink-0"
        on:click={() => { showCreate = true; updatingIncident = null; activeView = 'reported' }}>
        <Icon name="plus" size={14} />
        <span>{$t('incidents.newIncident')}</span>
      </button>
    </div>
  </div>

  <div class="px-4 py-5 md:px-8 md:py-8 max-w-5xl mx-auto space-y-4">

    <div class="inline-flex rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--bg-subtle))] p-1" role="tablist" aria-label="Incident views">
      <button type="button" role="tab" aria-selected={activeView === 'detected'}
        class="rounded-md px-4 py-2 text-sm font-medium {activeView === 'detected' ? 'bg-[rgb(var(--card))] shadow-sm' : ''}"
        on:click={() => activeView = 'detected'}>
        Detected events
        {#if detectedIncidents.length}<span class="ml-1 badge badge-warning">{detectedIncidents.length}</span>{/if}
      </button>
      <button type="button" role="tab" aria-selected={activeView === 'reported'}
        class="rounded-md px-4 py-2 text-sm font-medium {activeView === 'reported' ? 'bg-[rgb(var(--card))] shadow-sm' : ''}"
        on:click={() => activeView = 'reported'}>
        Status reports
        {#if incidents.length}<span class="ml-1 badge">{incidents.length}</span>{/if}
      </button>
    </div>

    {#if error}
      <div class="flex items-center gap-2 px-4 py-3 rounded text-sm"
        style="background: rgb(239 68 68 / .08); color: #ef4444; border: 1px solid rgb(239 68 68 / .3)">
        <Icon name="exclamation-triangle" size={14} />{error}
      </div>
    {/if}

    {#if showCreate}
    <div class="card space-y-5">
      <h2 class="text-sm font-semibold" style="color: rgb(var(--text))">{$t('incidents.formTitle')}</h2>
      <div class="grid grid-cols-2 gap-4">
        <div class="col-span-2">
          <label class="label" for="inc-title">{$t('incidents.labelTitle')}</label>
          <input id="inc-title" class="input" bind:value={createTitle} required placeholder="API latency degradation" />
        </div>
        <div class="col-span-2 sm:col-span-1">
          <label class="label" for="inc-status">{$t('incidents.labelStatus')}</label>
          <select id="inc-status" class="input" bind:value={createStatus}>
            {#each STATUSES as s}<option value={s}>{tIncidentStatus(s)}</option>{/each}
          </select>
        </div>
        <div class="col-span-2 sm:col-span-1">
          <label class="label" for="inc-impact">Impact</label>
          <select id="inc-impact" class="input" bind:value={createImpact}>
            <option value="minor">Minor</option>
            <option value="major">Major</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div class="col-span-2">
          <label class="label" for="inc-visibility">Publishing</label>
          <select id="inc-visibility" class="input" bind:value={createVisibility}>
            <option value="draft">Save as draft</option>
            <option value="published">Publish to status pages</option>
          </select>
          <p class="mt-1 text-xs" style="color: rgb(var(--text-muted))">Drafts are visible only to your team until published.</p>
        </div>
        <div class="col-span-2">
          <label class="label" for="inc-msg">{$t('incidents.labelMessage')}</label>
          <textarea id="inc-msg" class="input h-20 resize-none" bind:value={createMessage}
            placeholder={$t('incidents.placeholderMessage')}></textarea>
        </div>
        <div class="col-span-2">
          <p class="label mb-2">{$t('incidents.affectedMonitors')}</p>
          {#if allMonitors.length === 0}
            <p class="text-sm" style="color: rgb(var(--text-muted))">{$t('incidents.noMonitors')}</p>
          {:else}
            <div class="grid grid-cols-2 gap-1">
              {#each allMonitors as m}
                <label class="flex items-center gap-2 cursor-pointer text-sm p-2 rounded hover:bg-[rgb(var(--bg-subtle))]">
                  <input type="checkbox"
                    checked={createMonitorIds.includes(m.id)}
                    on:change={() => toggleMonitor(m.id)}
                    class="accent-primary" />
                  <span style="color: rgb(var(--text))">{m.name}</span>
                </label>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      {#if createError}<p class="text-sm text-red-400">{createError}</p>{/if}
      <div class="flex gap-2">
        <button class="btn-primary" on:click={create} disabled={creating}>
          {creating ? $t('incidents.creating') : $t('incidents.createIncident')}
        </button>
        <button class="btn-outline ml-auto" on:click={() => showCreate = false}>{$t('incidents.cancel')}</button>
      </div>
    </div>
    {/if}

    {#if updatingIncident}
    <div class="card space-y-5">
      <div>
        <h2 class="text-sm font-semibold" style="color: rgb(var(--text))">{$t('incidents.updateTitle')}</h2>
        <p class="text-xs mt-0.5 truncate" style="color: rgb(var(--text-muted))">{updatingIncident.title}</p>
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="label" for="upd-status">{$t('incidents.labelNewStatus')}</label>
          <select id="upd-status" class="input" bind:value={updateStatus}>
            {#each STATUSES as s}<option value={s}>{tIncidentStatus(s)}</option>{/each}
          </select>
        </div>
        <div class="col-span-2">
          <label class="label" for="upd-msg">{$t('incidents.labelUpdateMsg')}</label>
          <textarea id="upd-msg" class="input h-24 resize-none" bind:value={updateMessage} required
            placeholder={$t('incidents.placeholderUpdate')}></textarea>
        </div>
      </div>
      {#if updateError}<p class="text-sm text-red-400">{updateError}</p>{/if}
      <div class="flex gap-2">
        <button class="btn-primary" on:click={addUpdate} disabled={updating}>
          {updating ? $t('incidents.posting') : $t('incidents.postUpdate')}
        </button>
        <button class="btn-outline ml-auto" on:click={() => updatingIncident = null}>{$t('incidents.cancel')}</button>
      </div>
    </div>
    {/if}

    {#if activeView === 'detected' && !loading}
      {#if detectedIncidents.length === 0}
        <div class="card py-14 text-center">
          <div class="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-success-soft)] text-[var(--color-success)]">
            <Icon name="check" size={20} />
          </div>
          <p class="font-semibold">No unreported events</p>
          <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">Every detected outage is already linked to a status report.</p>
        </div>
      {:else}
        <div class="space-y-3">
          {#each detectedIncidents as event (event.id)}
            <article class="card flex flex-col gap-4 sm:flex-row sm:items-center">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="font-semibold">{event.monitorName}</h2>
                  <span class="badge {event.resolvedAt ? 'badge-success' : 'badge-danger'}">{event.resolvedAt ? 'Recovered' : 'Ongoing'}</span>
                </div>
                <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">
                  Detected {formatDate(event.startedAt)}
                  {#if event.durationSeconds} · {Math.max(1, Math.round(event.durationSeconds / 60))} min{/if}
                </p>
              </div>
              <button class="btn-primary shrink-0" on:click={() => reportDetected(event)}>
                Create report
              </button>
            </article>
          {/each}
        </div>
      {/if}
    {:else if loading}
      <div class="py-8 text-center text-sm" style="color: rgb(var(--text-muted))">{$t('incidents.loading')}</div>
    {:else if activeView === 'reported' && incidents.length === 0 && !showAnyForm}
      <div class="rounded text-center py-20 space-y-5"
        style="border: 1px solid var(--border-color); background-color: rgb(var(--card));
">
        <div class="w-14 h-14 rounded flex items-center justify-center mx-auto"
          style="background: color-mix(in srgb, var(--color-primary) 10%, transparent); color: var(--color-primary)">
          <Icon name="exclamation-triangle" size={24} />
        </div>
        <div>
          <p class="text-lg font-semibold tracking-tight" style="color: rgb(var(--text))">{$t('incidents.empty')}</p>
          <p class="text-sm mt-1.5 max-w-xs mx-auto" style="color: rgb(var(--text-muted))">
            {$t('incidents.emptyDesc')}
          </p>
        </div>
        <button class="btn-primary inline-flex" on:click={() => showCreate = true}>
          <Icon name="plus" size={14} />
          {$t('incidents.createFirst')}
        </button>
      </div>
    {:else if activeView === 'reported'}
      <div class="space-y-3">
        {#each incidents as inc (inc.id)}
          <div class="rounded p-4 space-y-3"
            style="border: 1px solid {!inc.resolvedAt ? 'rgb(239 68 68 / .35)' : 'var(--border-color)'}; background-color: rgb(var(--card))">

            <div class="flex items-start gap-3">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-semibold text-sm" style="color: rgb(var(--text))">{inc.title}</span>
                  <span class="text-xs px-2 py-0.5 rounded border font-medium {statusCls(inc.status)}">{tIncidentStatus(inc.status)}</span>
                  <span class="badge">{inc.impact}</span>
                  {#if inc.visibility === 'draft'}<span class="badge badge-warning">Draft</span>{/if}
                  {#if !inc.resolvedAt}
                    <span class="text-xs font-medium text-red-400">{$t('incidents.active')}</span>
                  {/if}
                </div>
                <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">{$t('incidents.started')} {formatDate(inc.startedAt)}</p>
                {#if inc.monitorIds && inc.monitorIds.length > 0}
                  <p class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">
                    {$t('incidents.affects')} {inc.monitorIds.map(monitorName).join(', ')}
                  </p>
                {/if}
              </div>
              <div class="flex items-center gap-2 shrink-0">
                {#if !inc.resolvedAt}
                  <button class="btn-outline px-2.5 py-1.5 text-xs" on:click={() => openUpdate(inc)}>
                    {$t('incidents.addUpdate')}
                  </button>
                {/if}
                <button class="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-400"
                  on:click={() => remove(inc)}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>

            {#if inc.updates && inc.updates.length > 0}
              <div class="space-y-2 pl-3 ml-1" style="border-left: 2px solid rgb(var(--border))">
                {#each inc.updates as u}
                  <div>
                    <div class="flex items-center gap-2">
                      <span class="text-xs px-1.5 py-0.5 rounded border {statusCls(u.status)}">{tIncidentStatus(u.status)}</span>
                      <span class="text-xs" style="color: rgb(var(--text-muted))">{formatDate(u.createdAt)}</span>
                    </div>
                    <p class="text-sm mt-0.5" style="color: rgb(var(--text))">{u.message}</p>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

  </div>
</div>
