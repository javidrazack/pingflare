<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from 'svelte/store'
  import { api } from '$lib/api'
  import { channels } from '$lib/stores'
  import { t } from '$lib/i18n'
  import DeliveryInbox from '$lib/components/DeliveryInbox.svelte'
  import NotificationForm from '$lib/components/NotificationForm.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import PageLoader from '$lib/components/PageLoader.svelte'
  import HeaderPattern from '$lib/components/HeaderPattern.svelte'
  import { channelTypeLabel } from '$lib/utils'
  import type { NotificationChannel } from '$lib/api'

  let loading = true
  let error = ''
  let showCreate = false
  let editChannel: NotificationChannel | null = null
  let createType: NotificationChannel['type'] = 'slack'

  async function loadChannels() {
    loading = true
    error = ''
    try {
      channels.set(await api.notifications.list())
    } catch {
      error = $t('notifications.loadFailed')
    } finally {
      loading = false
    }
  }

  onMount(loadChannels)

  async function deleteChannel(id: string, name: string) {
    if (!confirm(get(t)('confirm.deleteChannel', { name }))) return
    try {
      await api.notifications.delete(id)
      channels.update(list => list.filter(c => c.id !== id))
    } catch {
      error = $t('notifications.deleteFailed')
    }
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

  function startCreate(type: NotificationChannel['type'] = 'slack') {
    createType = type
    showCreate = true
    editChannel = null
  }

  const CHANNEL_ICONS: Record<string, string> = {
    discord: 'bell', slack: 'chat-bubble', telegram: 'paper-airplane',
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
      <button class="btn-primary shrink-0" on:click={() => startCreate()}>
        <Icon name="plus" size={14} />
        {$t('notifications.addChannel')}
      </button>
    </div>
  </div>

  <div class="px-4 py-5 md:px-8 md:py-8 max-w-5xl mx-auto space-y-4">

    <DeliveryInbox />

    {#if error}
      <div class="alert items-center text-sm" role="alert"
        style="background: rgb(var(--danger-bg)); color: var(--danger-fg)">
        <Icon name="exclamation-triangle" size={18} />
        <span class="min-w-0 flex-1">{error}</span>
        <button type="button" class="btn-outline shrink-0 text-inherit" on:click={loadChannels}>
          <Icon name="arrow-path" size={16} /> {$t('notifications.retry')}
        </button>
      </div>
    {/if}

    {#if showCreate}
    <div class="card">
      <h2 class="text-sm font-semibold mb-5" style="color: rgb(var(--text))">{$t('notifications.newChannel')}</h2>
      <NotificationForm channel={{ type: createType }} mode="create" on:saved={onSaved} on:cancel={() => showCreate = false} />
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

    {:else if !error && $channels.length === 0 && !showCreate}
      <div class="rounded px-5 py-10 text-center md:px-10 md:py-14"
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
        <div class="mx-auto mt-8 grid max-w-2xl gap-3 text-left sm:grid-cols-2">
          <button
            class="group min-h-28 rounded-xl border p-4 text-left transition-colors hover:bg-[rgb(var(--bg-subtle))]"
            on:click={() => startCreate('slack')}
          >
            <span class="flex items-center gap-3">
              <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-solid">
                <Icon name="chat-bubble" size={19} />
              </span>
              <span>
                <span class="block text-sm font-semibold" style="color: rgb(var(--text))">Slack</span>
                <span class="mt-0.5 block text-xs" style="color: rgb(var(--text-muted))">{$t('notifications.slackQuickDesc')}</span>
              </span>
            </span>
            <span class="mt-3 inline-flex items-center gap-1 text-xs font-semibold" style="color: var(--color-primary)">
              {$t('notifications.setupSlack')} <Icon name="arrow-up-right" size={13} />
            </span>
          </button>
          <button
            class="group min-h-28 rounded-xl border p-4 text-left transition-colors hover:bg-[rgb(var(--bg-subtle))]"
            on:click={() => startCreate('telegram')}
          >
            <span class="flex items-center gap-3">
              <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-solid">
                <Icon name="paper-airplane" size={19} />
              </span>
              <span>
                <span class="block text-sm font-semibold" style="color: rgb(var(--text))">Telegram</span>
                <span class="mt-0.5 block text-xs" style="color: rgb(var(--text-muted))">{$t('notifications.telegramQuickDesc')}</span>
              </span>
            </span>
            <span class="mt-3 inline-flex items-center gap-1 text-xs font-semibold" style="color: var(--color-primary)">
              {$t('notifications.setupTelegram')} <Icon name="arrow-up-right" size={13} />
            </span>
          </button>
        </div>
        <button class="btn-ghost mt-4 inline-flex" on:click={() => startCreate('discord')}>
          {$t('notifications.chooseAnother')}
        </button>
      </div>

    {:else}
      <div class="space-y-2">
        {#each $channels as ch (ch.id)}
          <div class="rounded flex flex-col items-stretch gap-4 px-4 py-4 transition-all sm:flex-row sm:items-center sm:px-5"
            style="background-color: rgb(var(--card)); border: 1px solid var(--border-color)">

            <div class="hidden h-10 w-10 rounded items-center justify-center shrink-0 sm:flex"
              style="background-color: rgb(var(--bg-muted)); color: rgb(var(--text-muted))">
              <Icon name={CHANNEL_ICONS[ch.type] ?? 'bell'} size={18} />
            </div>

            <div class="min-w-0 flex-1">
              <div class="font-medium text-sm" style="color: rgb(var(--text))">{ch.name}</div>
              <div class="text-xs mt-0.5" style="color: rgb(var(--text-muted))">{channelTypeLabel(ch.type)}</div>
            </div>

            <div class="flex flex-wrap items-center gap-2 shrink-0 sm:flex-nowrap">
              <span class="badge {ch.active ? 'badge-up' : 'badge-down'}">
                {ch.active ? $t('notifications.active') : $t('notifications.disabled')}
              </span>
              <button class="btn-ghost min-h-11 px-2.5 py-1.5 text-xs"
                on:click={() => { editChannel = ch; showCreate = false }}>
                <Icon name="pencil" size={14} />
                {$t('notifications.edit')}
              </button>
              <button
                class="inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-red-500/10"
                style="color: var(--danger-fg)"
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
