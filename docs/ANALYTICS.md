# Analytics Engine telemetry

Pingflare writes telemetry to two Workers Analytics Engine datasets:

- `pingflare_check_events_v1` through `CHECK_ANALYTICS`
- `pingflare_api_events_v1` through `API_ANALYTICS`

Before the first deployment, enable Analytics Engine once under **Workers & Pages → Analytics Engine** in the Cloudflare dashboard. The datasets themselves require no manual provisioning: their `wrangler.toml` bindings create them on first use after the account feature is enabled.

The application UI does not query Analytics Engine. Exact uptime comes from D1 daily rollups. This avoids storing a Cloudflare Account Analytics token in the Worker and avoids treating sampled telemetry as authoritative.

## Check event schema

`index1` is the monitor UUID.

| Column | Meaning |
|---|---|
| `blob1` | Schema: `check.v1` |
| `blob2` | Pingflare instance ID |
| `blob3` | Monitor UUID |
| `blob4` | Monitor type |
| `blob5` | `up` or `down` |
| `blob6` | Source: `cron`, `heartbeat`, or `agent` |
| `blob7` | Normalized result code |
| `blob8` | Cloudflare colo when known |
| `blob9` | Country code when known |
| `blob10` | SSL state when relevant |
| `double1` | Response time in milliseconds |
| `double2` | `1` when response time exists |
| `double3` | Up flag |
| `double4` | Down flag |
| `double5` | Observation Unix timestamp in seconds |
| `double6` | Agent CPU percent |
| `double7` | Agent RAM percent |
| `double8` | Agent disk percent |
| `double9` | Unhealthy/non-running container count |

Pingflare deliberately does not send monitor URLs, request headers, credentials, raw error messages, or origin IP addresses.

Example sampled uptime query:

```sql
SELECT
  index1 AS monitor_id,
  SUM(_sample_interval * double3)
    / NULLIF(SUM(_sample_interval * (double3 + double4)), 0) * 100 AS uptime_percent,
  SUM(_sample_interval * double1)
    / NULLIF(SUM(_sample_interval * double2), 0) AS avg_response_ms
FROM pingflare_check_events_v1
WHERE timestamp >= NOW() - INTERVAL '24' HOUR
GROUP BY index1
ORDER BY monitor_id
```

Analytics Engine may sample data, so aggregate counts and sums must be weighted by `_sample_interval`.

## API event schema

Successful API requests are sampled at `API_ANALYTICS_SAMPLE_RATE`, which defaults to `0.05`. Responses with status 400 or above are always recorded. Each point stores the inverse of its application-level inclusion probability so sampled successes and fully retained errors can be combined without bias.

| Column | Meaning |
|---|---|
| `blob1` | Schema: `api.v2` |
| `blob2` | Pingflare instance ID |
| `blob3` | Matched route pattern, not the raw URL |
| `blob4` | HTTP method |
| `blob5` | Normalized result code |
| `double1` | Handler duration in milliseconds |
| `double2` | Duration-present flag |
| `double3` | HTTP status code |
| `double4` | Error flag |
| `double5` | Event timestamp in milliseconds |
| `double6` | Application sampling weight: `1 / API_ANALYTICS_SAMPLE_RATE` for successes, `1` for errors |

Analytics Engine can also adaptively sample stored points. API queries must therefore multiply the application sampling weight (`double6`) by Analytics Engine's `_sample_interval`. A raw `COUNT()` or a query weighted by only one of those columns produces biased request and error rates.

Example weighted request, error-rate, and duration query:

```sql
SELECT
  blob3 AS operation,
  SUM(_sample_interval * double6) AS estimated_requests,
  SUM(_sample_interval * double6 * double4) AS estimated_errors,
  SUM(_sample_interval * double6 * double4)
    / NULLIF(SUM(_sample_interval * double6), 0) * 100 AS error_percent,
  SUM(_sample_interval * double6 * double1)
    / NULLIF(SUM(_sample_interval * double6 * double2), 0) AS avg_duration_ms
FROM pingflare_api_events_v1
WHERE blob1 = 'api.v2'
  AND timestamp >= NOW() - INTERVAL '24' HOUR
GROUP BY blob3
ORDER BY operation
```

Set `API_ANALYTICS_SAMPLE_RATE` above zero when estimating total request volume or error rate. At `0`, Pingflare intentionally records only errors, so success volume cannot be reconstructed.

Legacy `api.v1` points do not contain `double6`. Query them separately with the sampling rate that was active when they were written; do not mix them into the weighted `api.v2` query above.

## Querying

Use Cloudflare's Analytics Engine SQL API or Grafana integration from an administrative environment. Do not put an Account Analytics token in the browser.

Current Free-plan documentation includes 100,000 written data points and 10,000 read queries per day, with three-month retention:

- [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
