1. **Analyze UX Requirements for Agent setup**:
   - The user needs to easily discover how to install the agent from the UI.
   - When a user views an 'agent' monitor or its edit screen, there should be a clear, one-line copy-paste curl command.
   - We need to expose the generated `heartbeatTokens.token` via the API so the frontend can construct the command. (We already have `GET /api/monitors/:id/heartbeat-token` which works for both heartbeat and agent since they share the same tokens table).
2. **Update Frontend UI**:
   - In `frontend/src/lib/components/MonitorForm.svelte`: Add the 'agent' option to the monitor types tabs. Add inputs for `cpuThreshold`, `ramThreshold`, and `diskThreshold`.
   - In `frontend/src/routes/(app)/monitors/[id]/edit/+page.svelte` (or `HeartbeatBorder.svelte` equivalent): Display the installation command if the monitor type is `agent`.
   - In `frontend/src/routes/(app)/monitors/[id]/+page.svelte`: Display the most recent metrics (CPU, RAM, Disk, Docker) by reading `monitor.lastMetrics`.
3. **Write Documentation**:
   - Create `docs/AGENT.md` explaining how the agent works, how to install it, and what data it collects (CPU, RAM, Disk, Docker).
   - Update `README.md` to link to `AGENT.md`.
4. **Pre-commit Checks**:
   - Test frontend compilation and UI consistency.
5. **Submit Change**:
   - Commit and push to a new branch for the PR.
