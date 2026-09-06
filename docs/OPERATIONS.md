# Operational controls

Paused monitors are excluded from dashboard active-health totals. Previously
checked monitors become **Checks overdue** when their next scheduled check is
more than 90 seconds late; they are not presented as healthy. Never-checked
monitors remain pending. Public pages apply the same freshness rule.

Dashboard responses contain counts and at most 20 attention items. The separate
30-day uptime watchlist contains at most five items and refreshes every five
minutes. Full configuration remains available through monitor endpoints.

## Capacity

The manually refreshed capacity panel compares HTTP/DNS/port demand against the
existing normal two-check/minute admission rate. A second estimate adds inbound
sources to show demand if pushes stop, against the conservative one-check/minute
planning rate. These are application limits, including on Docker, not billing
entitlements or guaranteed detection times. Monitor creation shows projected
demand including the new monitor.

The panel shows overdue count, oldest overdue age, last completed scheduler
run, and the application's public-read reservation. The reservation does not
measure total Cloudflare account usage. A scheduler warning appears after
failure, before any recorded completion, or after three minutes without one.

Scheduler metadata uses the existing lease-release statement. No additional
recurring job is introduced. Manual authenticated runs reserve one query for
session validation; scheduled runs retain their existing admission budget.
`/api/health` remains a lightweight process-liveness endpoint.

## Notification deliveries

Notifications shows the first 50 pending deliveries and latest 50 provider
acceptance receipts. Pending rows show channels, failed/waiting state, queue
time, and next eligible attempt. Raw provider errors are not exposed because
they can contain credentials. Use channel configuration/tests for diagnosis.

**Retry next cycle** makes an unclaimed delivery eligible for the existing
bounded drain. It does not immediately send notifications or bypass maintenance,
relevance checks, or delivery ordering. Refresh is manual. At most 200 receipts
are retained, using a trigger on successful outbox progress. The trigger adds
writes only when a provider accepts a notification, without extra Worker-to-D1
calls. Acceptance does not guarantee inbox arrival or human acknowledgement.
Receipts begin after migration 0012; they are not backfilled.

## Maintenance

Use a monitor's **Maintenance** tab to schedule, view, or remove windows.
Times use the displayed browser timezone. Weekly repeats create 4 or 12
occurrences, preserving local wall time across daylight-saving changes. They
stop after the selected count; each occurrence is independently removable.

There is no recurring background generator. The API accepts 1–12 explicit
occurrences atomically, with at most 100 active/upcoming windows per monitor.
Each window must end in the future, last no more than 31 days, and end within
the next year. Checks and history continue under the existing maintenance rules.

## Sessions and upgrade

Apply `0012_awesome_longshot.sql` before deploying the updated Worker through
the normal `npm run deploy` path. Docker applies equivalent schema changes on
startup. The migration adds revoked sessions, delivery receipts, and scheduler
completion fields without backfilling history.

Existing administrator tokens become invalid on upgrade, requiring sign-in.
New tokens expire after 24 hours; refresh returns the same token without
extending expiry. Logout records revocation. Changing ADMIN_USER, ADMIN_PASS,
or JWT_SECRET invalidates all existing tokens. Each authenticated request adds
one indexed revocation lookup, shared by overlapping route middleware within
that request. SSE streams revalidate every 30 seconds and end after five minutes.

No new runtime secret, Cloudflare binding, queue subscription, or paid provider
is required. Extra database activity consumes existing quotas; $0 additional
hosting is a target subject to actual headroom, not a guarantee.
