<script lang="ts">
  import { t } from '$lib/i18n'

  export let status: 'up' | 'down' | 'pending'

  $: label = status === 'up'
    ? $t('dashboard.operational')
    : status === 'down'
    ? $t('dashboard.down')
    : $t('dashboard.pending')

  $: dotColor = status === 'up'
    ? 'var(--success-fg)'
    : status === 'down'
    ? 'var(--danger-fg)'
    : 'var(--pending-fg)'
</script>

<span class="badge
  {status === 'up'      ? 'badge-up'      : ''}
  {status === 'down'    ? 'badge-down'    : ''}
  {status === 'pending' ? 'badge-pending' : ''}
">
  <span class="h-1.5 w-1.5 rounded-full shrink-0" style="background: {dotColor}"></span>
  {label}
</span>
