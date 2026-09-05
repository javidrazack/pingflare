<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type MaintenanceWindow } from '$lib/api'
  import { t, locale } from '$lib/i18n'
  export let monitorId: string
  let windows: MaintenanceWindow[] = []
  let loading = true
  let saving = false
  let error = ''
  let notice = ''
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  function inputTime(date: Date) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  }
  let start = inputTime(new Date(Date.now() + 3600_000))
  let end = inputTime(new Date(Date.now() + 7200_000))
  let reason = ''
  let count = 1
  function time(value: number) { return new Date(value * 1000).toLocaleString($locale) }
  async function load() {
    loading = true
    error = ''
    try { windows = await api.monitors.maintenance(monitorId) }
    catch { error = $t('ops.loadFailed') }
    finally { loading = false }
  }
  onMount(load)
  async function save() {
    saving = true
    error = ''
    notice = ''
    try {
      const occurrences = Array.from({ length: count }, (_, i) => {
        const from = new Date(start)
        const to = new Date(end)
        // Calendar weeks in the displayed local timezone, preserving local wall time across DST.
        from.setDate(from.getDate() + i * 7)
        to.setDate(to.getDate() + i * 7)
        return { startAt: Math.floor(from.getTime() / 1000), endAt: Math.floor(to.getTime() / 1000) }
      })
      if (occurrences.some(w => !Number.isFinite(w.startAt) || !Number.isFinite(w.endAt)
        || w.startAt >= w.endAt || w.endAt <= Date.now() / 1000)) throw new Error($t('maintenance.invalid'))
      await api.monitors.scheduleMaintenance(monitorId, { ...occurrences[0], reason, occurrences })
      notice = $t('maintenance.saved', { count })
      await load()
    } catch (e) { error = e instanceof Error ? e.message : $t('ops.loadFailed') }
    finally { saving = false }
  }
  async function remove(id: string) {
    if (!confirm($t('maintenance.confirmDelete'))) return
    saving = true
    try { await api.monitors.deleteMaintenance(monitorId, id); await load() }
    catch { error = $t('ops.loadFailed') }
    finally { saving = false }
  }
</script>

<section class="card space-y-5" aria-labelledby="maintenance-title">
  <h2 id="maintenance-title" class="text-lg font-semibold">{$t('maintenance.heading')}</h2>
  <p class="text-sm" style="color: rgb(var(--text-muted))">{$t('maintenance.description', { zone })}</p>
  {#if error}<p role="alert" style="color: var(--danger-fg)">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  <form on:submit|preventDefault={save} class="space-y-4">
    <div class="grid gap-4 sm:grid-cols-2">
      <div><label class="label" for="maintenance-start">{$t('maintenance.start')}</label><input id="maintenance-start" class="input" type="datetime-local" bind:value={start} required /></div>
      <div><label class="label" for="maintenance-end">{$t('maintenance.end')}</label><input id="maintenance-end" class="input" type="datetime-local" bind:value={end} required /></div>
      <div><label class="label" for="maintenance-reason">{$t('maintenance.reason')}</label><input id="maintenance-reason" class="input" bind:value={reason} maxlength="500" /></div>
      <div><label class="label" for="maintenance-count">{$t('maintenance.repeat')}</label>
        <select id="maintenance-count" class="input" bind:value={count}>
          <option value={1}>{$t('maintenance.once')}</option><option value={4}>{$t('maintenance.weeks', { count: 4 })}</option><option value={12}>{$t('maintenance.weeks', { count: 12 })}</option>
        </select>
      </div>
    </div>
    <p class="text-xs" style="color: rgb(var(--text-muted))">{$t('maintenance.repeatNote')}</p>
    <button class="btn-primary" disabled={saving || loading}>{saving ? $t('maintenance.saving') : $t('maintenance.save')}</button>
  </form>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h3 class="font-semibold">{$t('maintenance.upcoming')}</h3>
    <button type="button" class="btn-outline" on:click={load} disabled={loading || saving}>{$t('ops.refresh')}</button>
  </div>
  {#if loading}<p role="status">{$t('ops.loading')}</p>
  {:else}<ul class="divide-y">
    {#each windows as window (window.id)}
      <li class="flex flex-wrap items-center justify-between gap-3 py-3">
        <div class="min-w-0"><p class="break-words text-sm">{time(window.startAt)} – {time(window.endAt)}</p><p class="break-words text-sm" style="color: rgb(var(--text-muted))">{window.reason ?? ''}</p></div>
        <button type="button" class="btn-outline" on:click={() => remove(window.id)} disabled={saving}>{$t('maintenance.delete')}</button>
      </li>
    {:else}<li class="py-3 text-sm">{$t('maintenance.empty')}</li>{/each}
  </ul>{/if}
</section>
