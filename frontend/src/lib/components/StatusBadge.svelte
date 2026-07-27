<script lang="ts">
  export let status: 'up' | 'down' | 'pending'
</script>

<span class="badge
  {status === 'up'      ? 'badge-up'      : ''}
  {status === 'down'    ? 'badge-down'    : ''}
  {status === 'pending' ? 'badge-pending' : ''}
">
  <span class="h-1.5 w-1.5 rounded-full shrink-0
    {status === 'up'      ? 'bg-green-500' : ''}
    {status === 'down'    ? 'bg-red-400 animate-pulse' : ''}
    {status === 'pending' ? 'bg-slate-500 dark:bg-slate-300' : ''}
  "></span>
  {status === 'up' ? 'Operational' : status === 'down' ? 'Down' : 'Pending'}
</span>
