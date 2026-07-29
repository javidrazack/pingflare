<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte'
  import { api } from '$lib/api'
  import { channelTypeLabel } from '$lib/utils'
  import Icon from '$lib/components/Icon.svelte'
  import type { NotificationChannel, NotificationChannelPayload, NotificationTestRun } from '$lib/api'
  import { t } from '$lib/i18n'

  export let channel: Partial<NotificationChannel> = {}
  export let mode: 'create' | 'edit' = 'create'

  type Field = {
    key: string
    label: string
    placeholder: string
    type?: string
    secret?: boolean
    required?: boolean
    helper?: string
  }

  const dispatch = createEventDispatcher<{ saved: NotificationChannel; cancel: void }>()

  const CHANNEL_TYPES = [
    'discord', 'slack', 'telegram', 'email', 'ntfy', 'pushover', 'webhook',
    'apprise', 'googlechat', 'msteams', 'matrix', 'pagerduty', 'twilio',
  ] as const

  let name = channel.name ?? ''
  let type: typeof CHANNEL_TYPES[number] = (channel.type as typeof CHANNEL_TYPES[number]) ?? 'slack'
  let configStr = channel.config ?? '{}'
  let active = channel.active ?? true
  let isDefault = channel.isDefault ?? false
  let applyToAll = false
  let error = ''
  let saving = false
  let testing = false
  let testResult = ''
  let testSucceeded = false
  let testRuns: NotificationTestRun[] = []
  let nameTouched = false
  let fieldErrors: Record<string, string> = {}
  let showSecrets: Record<string, boolean> = {}

  const encryptedFields: string[] = channel.encryptedFields ?? []

  let config: Record<string, string> = {}
  try { config = JSON.parse(configStr) } catch { config = {} }

  $: FIELDS = {
    discord:  [{ key: 'webhookUrl', label: $t('notifField.webhookUrl'), placeholder: 'https://discord.com/api/webhooks/...', secret: true }],
    slack:    [{
      key: 'webhookUrl',
      label: $t('notifField.webhookUrl'),
      placeholder: 'https://hooks.slack.com/services/…',
      secret: true,
      required: true,
      helper: $t('notificationForm.slackWebhookHelper'),
    }],
    telegram: [
      {
        key: 'botToken',
        label: $t('notifField.botToken'),
        placeholder: '123456789:AAExampleToken…',
        secret: true,
        required: true,
        helper: $t('notificationForm.telegramTokenHelper'),
      },
      {
        key: 'chatId',
        label: $t('notifField.chatId'),
        placeholder: '-1001234567890',
        required: true,
        helper: $t('notificationForm.telegramChatHelper'),
      },
    ],
    email: [
      { key: 'host',     label: $t('notifField.smtpHost'),     placeholder: 'smtp.example.com' },
      { key: 'port',     label: $t('notifField.smtpPort'),     placeholder: '587' },
      { key: 'user',     label: $t('notifField.username'),     placeholder: 'alerts@example.com' },
      { key: 'password', label: $t('notifField.password'),     placeholder: '', secret: true },
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
  } as Record<string, Field[]>

  $: selectedFields = FIELDS[type] ?? []
  $: nameError = nameTouched && !name.trim() ? $t('notificationForm.nameRequired') : ''

  function isFieldEncrypted(key: string): boolean {
    return mode === 'edit' && encryptedFields.includes(key)
  }

  function getFieldError(field: Field): string {
    return fieldErrors[field.key] ?? ''
  }

  function validateField(field: Field): string {
    const value = (config[field.key] ?? '').trim()
    if (field.required && !value && !isFieldEncrypted(field.key)) {
      return $t('notificationForm.fieldRequired', { field: field.label })
    }
    if (field.key === 'webhookUrl' && type === 'slack' && value) {
      try {
        const url = new URL(value)
        if (
          url.protocol !== 'https:'
          || !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
          || !url.pathname.startsWith('/services/')
        ) return $t('notificationForm.invalidSlackUrl')
      } catch {
        return $t('notificationForm.invalidSlackUrl')
      }
    }
    if (field.key === 'botToken' && value && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(value)) {
      return $t('notificationForm.invalidTelegramToken')
    }
    if (field.key === 'chatId' && value && !/^-?\d+$/.test(value) && !/^@[A-Za-z0-9_]{5,}$/.test(value)) {
      return $t('notificationForm.invalidTelegramChat')
    }
    return ''
  }

  function validateOneField(field: Field) {
    fieldErrors = { ...fieldErrors, [field.key]: validateField(field) }
  }

  function handleFieldInput(field: Field) {
    fieldErrors = { ...fieldErrors, [field.key]: '' }
    invalidateTest()
  }

  function invalidateTest() {
    testResult = ''
    testSucceeded = false
  }

  function changeType() {
    config = {}
    fieldErrors = {}
    showSecrets = {}
    invalidateTest()
  }

  function validate(includeName: boolean): boolean {
    if (includeName) nameTouched = true
    fieldErrors = Object.fromEntries(selectedFields.map((field) => [field.key, validateField(field)]))
    const hasNameError = includeName && !name.trim()
    return !hasNameError && Object.values(fieldErrors).every((value) => !value)
  }

  async function focusFirstError(includeName: boolean) {
    await tick()
    const selector = includeName && !name.trim()
      ? '#ch-name'
      : selectedFields.map((field) => `#field-${field.key}`).find((id) => {
        const field = selectedFields.find((item) => `#field-${item.key}` === id)
        return field ? Boolean(getFieldError(field)) : false
      })
    if (selector) document.querySelector<HTMLElement>(selector)?.focus()
  }

  function errorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  function buildConfig(): Record<string, string> {
    const outConfig: Record<string, string> = {}
    for (const [key, value] of Object.entries(config)) {
      const field = selectedFields.find((item) => item.key === key)
      if (field?.secret && (!value || value.length === 0)) continue
      outConfig[key] = value.trim()
    }
    return outConfig
  }

  async function loadTests() {
    if (!channel.id) return
    try { testRuns = await api.notifications.tests(channel.id) } catch { testRuns = [] }
  }

  onMount(loadTests)

  async function save() {
    error = ''
    if (!validate(true)) {
      error = $t('notificationForm.fixFields')
      await focusFirstError(true)
      return
    }

    saving = true
    try {
      const payload: NotificationChannelPayload = {
        name: name.trim(),
        type,
        config: buildConfig(),
        active,
        isDefault,
      }
      let result: NotificationChannel
      if (mode === 'edit' && channel.id) {
        result = await api.notifications.update(channel.id, payload)
        if (applyToAll) await api.notifications.applyToAllMonitors(channel.id)
      } else {
        result = await api.notifications.create(payload)
        if (applyToAll) await api.notifications.applyToAllMonitors(result.id)
      }
      dispatch('saved', result)
    } catch (value) {
      error = errorMessage(value)
    } finally {
      saving = false
    }
  }

  async function test() {
    error = ''
    testResult = ''
    testSucceeded = false
    if (!validate(false)) {
      error = $t('notificationForm.fixConnectionFields')
      await focusFirstError(false)
      return
    }

    testing = true
    try {
      const latencyMs = mode === 'edit' && channel.id
        ? (await api.notifications.test(channel.id)).run.latencyMs
        : (await api.notifications.previewTest({ name: name.trim() || undefined, type, config: buildConfig() })).latencyMs
      testResult = `${$t('notificationForm.testSuccess')} (${latencyMs} ms)`
      testSucceeded = true
    } catch (value) {
      testResult = $t('notificationForm.testFailed', { error: errorMessage(value) })
    } finally {
      await loadTests()
      testing = false
    }
  }
</script>

<form on:submit|preventDefault={save} class="space-y-6" novalidate>
  <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
    <div class="space-y-5">
      <div>
        <label for="ch-name" class="label">
          {$t('notificationForm.name')} <span aria-hidden="true">*</span>
        </label>
        <input
          id="ch-name"
          class="input"
          class:border-red-500={Boolean(nameError)}
          bind:value={name}
          on:input={invalidateTest}
          on:blur={() => nameTouched = true}
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? 'ch-name-error' : undefined}
          placeholder={$t('notificationForm.namePlaceholder', { type: channelTypeLabel(type) })}
          autocomplete="off"
        />
        {#if nameError}
          <p id="ch-name-error" class="mt-1.5 text-sm" style="color: var(--danger-fg)" role="alert">{nameError}</p>
        {/if}
      </div>

      <div>
        <label for="ch-type" class="label">{$t('notificationForm.type')}</label>
        <select id="ch-type" class="input" bind:value={type} on:change={changeType}>
          {#each CHANNEL_TYPES as channelType}
            <option value={channelType}>{channelTypeLabel(channelType)}</option>
          {/each}
        </select>
      </div>

      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold" style="color: rgb(var(--text))">
          {$t('notificationForm.connectionDetails')}
        </legend>
        <p class="text-sm" style="color: rgb(var(--text-muted))">
          {$t('notificationForm.connectionDetailsDesc', { type: channelTypeLabel(type) })}
        </p>

        {#each selectedFields as field}
          {@const fieldError = fieldErrors[field.key] ?? ''}
          <div>
            <div class="mb-1.5 flex items-center justify-between gap-3">
              <label for="field-{field.key}" class="text-[0.8125rem] font-medium" style="color: rgb(var(--text-muted))">
                {field.label}{#if field.required} <span aria-hidden="true">*</span>{/if}
              </label>
              {#if field.secret}
                <button
                  type="button"
                  class="min-h-8 rounded px-2 text-xs font-medium transition-colors hover:bg-[rgb(var(--bg-muted))]"
                  style="color: rgb(var(--text-muted))"
                  on:click={() => showSecrets[field.key] = !showSecrets[field.key]}
                  aria-controls="field-{field.key}"
                  aria-pressed={Boolean(showSecrets[field.key])}
                >
                  {showSecrets[field.key] ? $t('notificationForm.hideValue') : $t('notificationForm.showValue')}
                </button>
              {/if}
            </div>
            <input
              id="field-{field.key}"
              class="input font-mono text-xs"
              class:border-red-500={Boolean(fieldError)}
              bind:value={config[field.key]}
              placeholder={isFieldEncrypted(field.key) ? $t('notifField.encryptedPlaceholder') : field.placeholder}
              type={field.secret && !showSecrets[field.key] ? 'password' : (field.type ?? 'text')}
              on:input={() => handleFieldInput(field)}
              on:blur={() => validateOneField(field)}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={fieldError ? `field-${field.key}-error` : `field-${field.key}-hint`}
              autocomplete="off"
              spellcheck="false"
            />
            {#if fieldError}
              <p id="field-{field.key}-error" class="mt-1.5 text-sm" style="color: var(--danger-fg)" role="alert">
                {fieldError}
              </p>
            {:else}
              <p id="field-{field.key}-hint" class="mt-1.5 text-xs leading-5" style="color: rgb(var(--text-muted))">
                {#if isFieldEncrypted(field.key)}
                  {$t('notifField.encryptedHint')}
                {:else if field.helper}
                  {field.helper}
                {/if}
              </p>
            {/if}
          </div>
        {/each}
      </fieldset>

      <div class="rounded-xl border p-4" style="background-color: rgb(var(--bg-subtle))">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-sm font-semibold" style="color: rgb(var(--text))">
              {$t('notificationForm.testConnection')}
            </p>
            <p class="mt-1 text-xs leading-5" style="color: rgb(var(--text-muted))">
              {mode === 'edit'
                ? $t('notificationForm.testSavedHint')
                : $t('notificationForm.testBeforeSaveHint')}
            </p>
          </div>
          <button type="button" class="btn-outline shrink-0" on:click={test} disabled={testing || saving}>
            <Icon name={testing ? 'arrow-path' : 'paper-airplane'} size={16} cls={testing ? 'animate-spin' : ''} />
            {testing ? $t('notificationForm.sending') : $t('notificationForm.sendTest')}
          </button>
        </div>
        {#if testResult}
          <div
            class="alert mt-3 {testSucceeded ? 'alert-success' : 'alert-danger'} text-sm"
            role="status"
            aria-live="polite"
          >
            <Icon name={testSucceeded ? 'check-circle' : 'x-circle'} size={18} />
            <span>{testResult}</span>
          </div>
        {/if}
      </div>
    </div>

    {#if type === 'slack' || type === 'telegram'}
      <aside class="h-fit rounded-xl border p-5 lg:sticky lg:top-6" style="background-color: rgb(var(--bg-subtle))" aria-labelledby="setup-guide-title">
        <div class="flex items-start gap-3">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-solid">
            <Icon name={type === 'slack' ? 'chat-bubble' : 'paper-airplane'} size={18} />
          </div>
          <div>
            <p class="text-xs font-semibold uppercase tracking-wider" style="color: var(--color-primary)">
              {$t('notificationForm.setupGuide')}
            </p>
            <h3 id="setup-guide-title" class="mt-0.5 text-base font-semibold" style="color: rgb(var(--text))">
              {$t(type === 'slack' ? 'notificationForm.slackGuideTitle' : 'notificationForm.telegramGuideTitle')}
            </h3>
          </div>
        </div>

        <ol class="mt-5 space-y-5">
          {#each (type === 'slack' ? [1, 2, 3] : [1, 2, 3, 4]) as step}
            <li class="flex gap-3">
              <span
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                style="background: color-mix(in srgb, var(--color-primary) 14%, transparent); color: var(--color-primary)"
              >{step}</span>
              <div>
                <p class="text-sm font-medium" style="color: rgb(var(--text))">
                  {$t(`notificationForm.${type}Step${step}Title` as Parameters<typeof $t>[0])}
                </p>
                <p class="mt-1 text-xs leading-5" style="color: rgb(var(--text-muted))">
                  {$t(`notificationForm.${type}Step${step}Body` as Parameters<typeof $t>[0])}
                </p>
              </div>
            </li>
          {/each}
        </ol>

        <div class="mt-5 border-t pt-4">
          <a
            class="inline-flex min-h-11 items-center gap-2 text-sm font-semibold hover:underline"
            style="color: var(--color-primary)"
            href={type === 'slack' ? 'https://api.slack.com/apps' : 'https://t.me/BotFather'}
            target="_blank"
            rel="noreferrer"
          >
            {$t(type === 'slack' ? 'notificationForm.openSlackApps' : 'notificationForm.openBotFather')}
            <Icon name="arrow-up-right" size={15} />
          </a>
          <p class="mt-2 flex gap-2 text-xs leading-5" style="color: rgb(var(--text-muted))">
            <Icon name="shield-check" size={16} cls="mt-0.5 shrink-0" />
            <span>{$t('notificationForm.credentialsEncrypted')}</span>
          </p>
        </div>
      </aside>
    {/if}
  </div>

  <fieldset class="rounded-xl border p-4">
    <legend class="px-1 text-sm font-semibold" style="color: rgb(var(--text))">
      {$t('notificationForm.deliverySettings')}
    </legend>
    <p class="mb-3 px-1 text-xs leading-5" style="color: rgb(var(--text-muted))">
      {$t('notificationForm.deliverySettingsDesc')}
    </p>
    <div class="grid gap-2 md:grid-cols-3">
      <label for="ch-active" class="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-[rgb(var(--bg-muted))]">
        <input type="checkbox" id="ch-active" bind:checked={active} class="mt-1 accent-primary" />
        <span class="text-sm" style="color: rgb(var(--text-muted))">{$t('notificationForm.active')}</span>
      </label>
      <label for="ch-default" class="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-[rgb(var(--bg-muted))]">
        <input type="checkbox" id="ch-default" bind:checked={isDefault} class="mt-1 accent-primary" />
        <span class="text-sm" style="color: rgb(var(--text-muted))">{$t('notificationForm.isDefault')}</span>
      </label>
      <label for="ch-apply-all" class="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-[rgb(var(--bg-muted))]">
        <input type="checkbox" id="ch-apply-all" bind:checked={applyToAll} class="mt-1 accent-primary" />
        <span class="text-sm" style="color: rgb(var(--text-muted))">{$t('notificationForm.applyToAll')}</span>
      </label>
    </div>
  </fieldset>

  {#if error}
    <div class="alert alert-danger text-sm" role="alert" aria-live="assertive">
      <Icon name="exclamation-triangle" size={18} />
      <span>{error}</span>
    </div>
  {/if}

  {#if mode === 'edit' && testRuns.length > 0}
    <section aria-labelledby="test-history-title" class="rounded-xl border">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <h3 id="test-history-title" class="text-sm font-semibold">{$t('notificationForm.testHistory')}</h3>
        <span class="text-xs" style="color: rgb(var(--text-muted))">
          {$t('notificationForm.latestTests', { count: Math.min(testRuns.length, 5) })}
        </span>
      </div>
      <ul class="divide-y divide-[var(--border-color)]">
        {#each testRuns.slice(0, 5) as run}
          <li class="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-start sm:gap-3">
            <span class="mt-1.5 hidden h-2 w-2 shrink-0 rounded-full sm:block {run.status === 'success' ? 'bg-emerald-500' : 'bg-red-500'}" aria-hidden="true"></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2">
                <span class="font-medium">
                  {run.status === 'success' ? $t('notificationForm.delivered') : $t('notificationForm.failed')}
                </span>
                <span class="font-mono text-xs" style="color: rgb(var(--text-muted))">{run.latencyMs} ms</span>
              </div>
              {#if run.error}<p class="mt-0.5 break-words text-xs" style="color: var(--danger-fg)">{run.error}</p>{/if}
            </div>
            <time class="shrink-0 text-xs" datetime={new Date(run.createdAt * 1000).toISOString()} style="color: rgb(var(--text-muted))">
              {new Date(run.createdAt * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
            </time>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row">
    <button type="button" class="btn-outline sm:ml-auto" on:click={() => dispatch('cancel')} disabled={saving || testing}>
      {$t('notificationForm.cancel')}
    </button>
    <button type="submit" class="btn-primary" disabled={saving || testing}>
      {#if saving}<Icon name="arrow-path" size={16} cls="animate-spin" />{/if}
      {saving
        ? $t('notificationForm.saving')
        : mode === 'edit'
          ? $t('notificationForm.saveChanges')
          : $t('notificationForm.createChannel')}
    </button>
  </div>
</form>
