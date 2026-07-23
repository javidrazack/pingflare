<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { api } from '$lib/api'
  import { channelTypeLabel } from '$lib/utils'
  import type { NotificationChannel, NotificationChannelPayload } from '$lib/api'
  import { t } from '$lib/i18n'

  export let channel: Partial<NotificationChannel> = {}
  export let mode: 'create' | 'edit' = 'create'

  const dispatch = createEventDispatcher<{ saved: NotificationChannel; cancel: void }>()

  const CHANNEL_TYPES = [
    'discord', 'slack', 'telegram', 'email', 'ntfy', 'pushover', 'webhook',
    'apprise', 'googlechat', 'msteams', 'matrix', 'pagerduty', 'twilio',
  ] as const

  let name = channel.name ?? ''
  let type: typeof CHANNEL_TYPES[number] = (channel.type as typeof CHANNEL_TYPES[number]) ?? 'discord'
  let configStr = channel.config ?? '{}'
  let active = channel.active ?? true
  let isDefault = channel.isDefault ?? false
  let applyToAll = false
  let error = ''
  let saving = false
  let testing = false
  let testResult = ''

  const encryptedFields: string[] = channel.encryptedFields ?? []

  let config: Record<string, string> = {}
  try { config = JSON.parse(configStr) } catch { config = {} }

  $: FIELDS = {
    discord:  [{ key: 'webhookUrl', label: $t('notifField.webhookUrl'), placeholder: 'https://discord.com/api/webhooks/...', secret: true }],
    slack:    [{ key: 'webhookUrl', label: $t('notifField.webhookUrl'), placeholder: 'https://hooks.slack.com/services/...', secret: true }],
    telegram: [
      { key: 'botToken', label: $t('notifField.botToken'), placeholder: '123456:ABC-DEF...', secret: true },
      { key: 'chatId',   label: $t('notifField.chatId'),   placeholder: '-100123456789' },
    ],
    email: [
      { key: 'host',     label: $t('notifField.smtpHost'),     placeholder: 'smtp.example.com' },
      { key: 'port',     label: $t('notifField.smtpPort'),     placeholder: '587' },
      { key: 'user',     label: $t('notifField.username'),     placeholder: 'alerts@example.com' },
      { key: 'password', label: $t('notifField.password'),     placeholder: '', type: 'password', secret: true },
      { key: 'from',     label: $t('notifField.fromAddress'),  placeholder: 'alerts@example.com' },
      { key: 'to',       label: $t('notifField.toAddresses'),  placeholder: 'you@example.com' },
    ],
    ntfy: [
      { key: 'url',   label: $t('notifField.serverUrl'),    placeholder: 'https://ntfy.sh' },
      { key: 'topic', label: $t('notifField.topic'),        placeholder: 'my-alerts' },
      { key: 'token', label: $t('notifField.tokenOptional'), placeholder: '', secret: true },
    ],
    pushover: [
      { key: 'token', label: $t('notifField.appToken'), placeholder: 'azGDORePK8gMaC0QOYAMyEEuzJnyUi', secret: true },
      { key: 'user',  label: $t('notifField.userKey'),  placeholder: 'uQiRzpo4DXghDmr9QzzfQu', secret: true },
    ],
    webhook: [
      { key: 'url',    label: $t('notifField.url'),            placeholder: 'https://your-server.com/hook', secret: true },
      { key: 'secret', label: $t('notifField.secretOptional'), placeholder: '', secret: true },
    ],
    apprise: [
      { key: 'url',   label: $t('notifField.appriseApiUrl'),     placeholder: 'http://apprise:8000' },
      { key: 'urls',  label: $t('notifField.notificationUrls'),  placeholder: 'slack://tokenA/tokenB/tokenC', secret: true },
      { key: 'token', label: $t('notifField.apiTokenOptional'),  placeholder: '', secret: true },
    ],
    googlechat: [
      { key: 'webhookUrl', label: $t('notifField.webhookUrl'), placeholder: 'https://chat.googleapis.com/v1/spaces/.../messages?key=...', secret: true },
    ],
    msteams: [
      { key: 'webhookUrl', label: $t('notifField.webhookUrl'), placeholder: 'https://...webhook.office.com/...', secret: true },
    ],
    matrix: [
      { key: 'homeserverUrl', label: $t('notifField.homeserverUrl'), placeholder: 'https://matrix.example.com' },
      { key: 'accessToken', label: $t('notifField.accessToken'), placeholder: '', secret: true },
      { key: 'roomId', label: $t('notifField.roomId'), placeholder: '!room:example.com' },
    ],
    pagerduty: [
      { key: 'routingKey', label: $t('notifField.routingKey'), placeholder: '', secret: true },
    ],
    twilio: [
      { key: 'accountSid', label: $t('notifField.accountSid'), placeholder: 'AC...' },
      { key: 'authToken', label: $t('notifField.authToken'), placeholder: '', secret: true },
      { key: 'fromNumber', label: $t('notifField.fromNumber'), placeholder: '+15551234567' },
      { key: 'toNumber', label: $t('notifField.toNumber'), placeholder: '+15557654321' },
    ],
  } as Record<string, { key: string; label: string; placeholder: string; type?: string; secret?: boolean }[]>

  function isFieldEncrypted(key: string): boolean {
    return mode === 'edit' && encryptedFields.includes(key)
  }

  async function save() {
    saving = true
    error = ''
    try {
      const outConfig: Record<string, string> = {}
      for (const [k, v] of Object.entries(config)) {
        const field = (FIELDS[type] ?? []).find(f => f.key === k)
        if (field?.secret && (!v || v.length === 0)) continue
        outConfig[k] = v
      }

      const payload: NotificationChannelPayload = { name, type, config: outConfig, active, isDefault }
      let result: NotificationChannel
      if (mode === 'edit' && channel.id) {
        result = await api.notifications.update(channel.id, payload)
        if (applyToAll) await api.notifications.applyToAllMonitors(channel.id)
      } else {
        result = await api.notifications.create(payload)
        if (applyToAll) await api.notifications.applyToAllMonitors(result.id)
      }
      dispatch('saved', result)
    } catch (e) {
      error = String(e)
    } finally {
      saving = false
    }
  }

  async function test() {
    if (!channel.id) return
    testing = true
    testResult = ''
    try {
      await api.notifications.test(channel.id)
      testResult = $t('notificationForm.testSuccess')
    } catch (e) {
      testResult = `Error: ${e}`
    } finally {
      testing = false
    }
  }
</script>

<form on:submit|preventDefault={save} class="space-y-4">
  <div>
    <label for="ch-name" class="label">{$t('notificationForm.name')}</label>
    <input id="ch-name" class="input" bind:value={name} required placeholder="My Discord alert" />
  </div>

  <div>
    <label for="ch-type" class="label">{$t('notificationForm.type')}</label>
    <select id="ch-type" class="input" bind:value={type} on:change={() => { config = {} }}>
      {#each CHANNEL_TYPES as t}
        <option value={t}>{channelTypeLabel(t)}</option>
      {/each}
    </select>
  </div>

  {#each FIELDS[type] ?? [] as field}
    <div>
      <label for="field-{field.key}" class="label">{field.label}</label>
      {#if isFieldEncrypted(field.key)}
        <input
          id="field-{field.key}"
          class="input font-mono text-xs"
          bind:value={config[field.key]}
          placeholder={$t('notifField.encryptedPlaceholder')}
          type={field.type ?? 'text'}
        />
        <p class="mt-1 text-xs text-[rgb(var(--text-muted))]">{$t('notifField.encryptedHint')}</p>
      {:else}
        <input
          id="field-{field.key}"
          class="input font-mono text-xs"
          bind:value={config[field.key]}
          placeholder={field.placeholder}
          type={field.type ?? 'text'}
        />
      {/if}
    </div>
  {/each}

  <div class="flex items-center gap-2">
    <input type="checkbox" id="ch-active" bind:checked={active} class="accent-primary" />
    <label for="ch-active" class="text-sm text-[rgb(var(--text-muted))]">{$t('notificationForm.active')}</label>
  </div>

  <div class="flex items-center gap-2">
    <input type="checkbox" id="ch-default" bind:checked={isDefault} class="accent-primary" />
    <label for="ch-default" class="text-sm text-[rgb(var(--text-muted))]">{$t('notificationForm.isDefault')}</label>
  </div>

  <div class="flex items-center gap-2">
    <input type="checkbox" id="ch-apply-all" bind:checked={applyToAll} class="accent-primary" />
    <label for="ch-apply-all" class="text-sm text-[rgb(var(--text-muted))]">{$t('notificationForm.applyToAll')}</label>
  </div>

  {#if error}
    <p class="text-sm text-red-400">{error}</p>
  {/if}

  {#if testResult}
    <p class="text-sm {testResult.startsWith('Error') ? 'text-red-400' : 'text-green-500'}">{testResult}</p>
  {/if}

  <div class="flex gap-2 pt-1">
    <button type="submit" class="btn-primary" disabled={saving}>
      {saving ? $t('notificationForm.saving') : mode === 'edit' ? $t('notificationForm.saveChanges') : $t('notificationForm.createChannel')}
    </button>
    {#if mode === 'edit' && channel.id}
      <button type="button" class="btn-outline" on:click={test} disabled={testing}>
        {testing ? $t('notificationForm.sending') : $t('notificationForm.sendTest')}
      </button>
    {/if}
    <button type="button" class="btn-outline ml-auto" on:click={() => dispatch('cancel')}>{$t('notificationForm.cancel')}</button>
  </div>
</form>
