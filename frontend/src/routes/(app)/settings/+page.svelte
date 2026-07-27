<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from 'svelte/store'
  import { api } from '$lib/api'
  import { channels } from '$lib/stores'
  import { t } from '$lib/i18n'
  import NotificationForm from '$lib/components/NotificationForm.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import PageLoader from '$lib/components/PageLoader.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'
  import { channelTypeLabel } from '$lib/utils'
  import type { NotificationChannel } from '$lib/api'

  let loading = true
  let showCreate = false
  let editChannel: NotificationChannel | null = null

  onMount(async () => {
    channels.set(await api.notifications.list())
    loading = false
  })

  async function deleteChannel(id: string, name: string) {
    if (!confirm(get(t)('confirm.deleteChannel', { name }))) return
    await api.notifications.delete(id)
    channels.update(list => list.filter(c => c.id !== id))
  }

  function onSaved(e: CustomEvent<NotificationChannel>) {
    channels.update(list => {
      const idx = list.findIndex(c => c.id === e.detail.id)
      if (idx >= 0) { list[idx] = e.detail; return [...list] }
      return [...list, e.detail]
    })
    showCreate = false
    editChannel = null
  }

  const CHANNEL_ICONS: Record<string, string> = {
    discord: 'bell', slack: 'bell', telegram: 'arrow-up-right',
    email: 'clipboard', ntfy: 'bell', pushover: 'bell',
    webhook: 'globe', apprise: 'cog',
  }
</script>

<svelte:head><title>{$t('notifications.heading')} - Pingflare</title></svelte:head>

<div style="background-color: rgb(var(--bg))">

  <div class="relative overflow-hidden" style="border-bottom: 1px solid var(--border-color)">
    <HeaderPattern />
    <div class="relative px-4 py-6 md:px-8 md:py-8 max-w-5xl mx-auto flex items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl md:text-3xl font-semibold tracking-tight" style="color: rgb(var(--text))">{$t('notifications.heading')}</h1>
        <p class="mt-1 text-sm" style="color: rgb(var(--text-muted))">
          {$t('notifications.subtitle')}
        </p>
      </div>
      <button class="btn-primary shrink-0" on:click={() => { showCreate = true; editChannel = null }}>
        <Icon name="plus" size={14} />
        {$t('notifications.addChannel')}
      </button>
    </div>
  </div>

  <div class="px-4 py-5 md:px-8 md:py-8 max-w-5xl mx-auto space-y-4">

    {#if showCreate}
    <div class="card">
      <h2 class="text-sm font-semibold mb-5" style="color: rgb(var(--text))">{$t('notifications.newChannel')}</h2>
      <NotificationForm mode="create" on:saved={onSaved} on:cancel={() => showCreate = false} />
    </div>
    {/if}

    {#if editChannel}
    <div class="card">
      <h2 class="text-sm font-semibold mb-5" style="color: rgb(var(--text))">{$t('notifications.editChannel', { name: editChannel.name })}</h2>
      <NotificationForm
        channel={editChannel}
        mode="edit"
        on:saved={onSaved}
        on:cancel={() => editChannel = null}
      />
    </div>
    {/if}

    {#if loading}
      <PageLoader />

    {:else if $channels.length === 0 && !showCreate}
      <div class="rounded text-center py-20 space-y-5"
        style="border: 1px solid var(--border-color); background-color: rgb(var(--card));
">
        <div class="w-14 h-14 rounded flex items-center justify-center mx-auto"
          style="background: color-mix(in srgb, var(--color-primary) 10%, transparent); color: var(--color-primary)">
          <Icon name="bell" size={24} />
        </div>
        <div>
          <p class="text-lg font-semibold tracking-tight" style="color: rgb(var(--text))">{$t('notifications.empty')}</p>
          <p class="text-sm mt-1.5 max-w-xs mx-auto" style="color: rgb(var(--text-muted))">
            {$t('notifications.emptyDesc')}
          </p>
        </div>
        <button class="btn-primary inline-flex" on:click={() => showCreate = true}>
          <Icon name="plus" size={14} />
          {$t('notifications.addFirst')}
        </button>
      </div>

    {:else}
      <div class="space-y-2">
        {#each $channels as ch (ch.id)}
          <div class="rounded flex items-center gap-4 px-5 py-4 transition-all"
            style="background-color: rgb(var(--card)); border: 1px solid var(--border-color)">

            <div class="rounded flex items-center justify-center shrink-0"
              style="background-color: rgb(var(--bg-muted)); color: rgb(var(--text-muted))">
              <Icon name={CHANNEL_ICONS[ch.type] ?? 'bell'} size={18} />
            </div>

            <div class="min-w-0 flex-1">
              <div class="font-medium text-sm" style="color: rgb(var(--text))">{ch.name}</div>
              <div class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">{channelTypeLabel(ch.type)}</div>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <span class="badge {ch.active ? 'badge-up' : 'badge-down'}">
                {ch.active ? $t('notifications.active') : $t('notifications.disabled')}
              </span>
              <button class="btn-ghost px-2.5 py-1.5 text-xs"
                on:click={() => { editChannel = ch; showCreate = false }}>
                <Icon name="pencil" size={14} />
                {$t('notifications.edit')}
              </button>
              <button
                class="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-400 transition-colors"
                style="hover:background: rgb(239 68 68 / .08)"
                on:click={() => deleteChannel(ch.id, ch.name)}>
                <Icon name="trash" size={14} />
                {$t('notifications.delete')}
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

  </div>
</div>
