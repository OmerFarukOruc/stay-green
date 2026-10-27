# stay-green reference

## Commands

`stay-green` is a single Python script that requires Python 3.9 or newer for `zoneinfo` and uses the standard library with no third-party packages.

| Command | Effect |
|---|---|
| `stay-green login` | Opens the Microsoft sign-in in the browser and waits up to 5 minutes for the redirect to `http://localhost:<port>`. Stores the refresh token in the state folder on this computer, deletes `access-token` and `renewal-failed` there, and prints `Stored the sign-in in <folder>. Test it with: <path of the script> status`. |
| `stay-green login HOST` | Runs the same sign-in, then sends the refresh token and a line break to `ssh -- HOST sh -c '...'`. On `HOST`, the command stores the token only when the whole line arrived. While it holds `lock` with `flock`, it deletes `access-token` and `renewal-failed`, writes a private temporary file, and renames it over `refresh-token`. Prints `Stored the sign-in on HOST. Test it there with the status command of stay-green.` `HOST` needs `flock` and `mktemp`, which util-linux and coreutils provide. |
| `stay-green run` | Ends at once when now is outside the schedule. Otherwise reads your presence. When Graph reports you out of office, prints that and stops. When the schedule ended while the run waited for Microsoft, prints that and stops. Otherwise marks the stay-green presence session Available for 15 minutes. |
| `stay-green status` | Prints `<availability> / <activity>`, with `, out of office` added when Graph reports it. Then prints `now is inside the schedule` or `now is outside the schedule`. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | The command succeeded. `run` also exits 0 outside the schedule and when you are out of office. |
| 1 | The command failed. An expected error prints one line that starts with `stay-green:`. An unexpected one prints a Python traceback. |
| 64 | The arguments are wrong. The script prints `usage: stay-green login [HOST] \| stay-green run \| stay-green status`. |

`systemd/stay-green-container run` and `systemd/stay-green-container status` execute those subcommands inside a rootless Podman container built on `docker.io/library/python:3.13-alpine`:

- The first run of each calendar day passes `--pull=newer` to check the registry for a newer image, falls back to the local image if the registry is unreachable, and records the check's timestamp in `.image-checked` in the state folder. Subsequent runs that day pass `--pull=missing` and pull an image if none exists on disk.
- The container runs with a read-only root file system, all Linux capabilities dropped, `no-new-privileges`, SELinux label separation disabled for the container, and a 64 MB memory limit.
- The wrapper mounts the script read-only, mounts the state folder read-write, mounts `/etc/localtime` read-only when present on the host, and forwards `STAY_GREEN_SCHEDULE` and `STAY_GREEN_TIME_ZONE`.
- `--log-driver=none` and `--events-backend=none` suppress Podman's own log and event entries so the journal captures the script's output alone.

Because `login` opens a local browser, `systemd/stay-green-container` does not support `login`.

## Schedule

The Python script reads its schedule from `STAY_GREEN_SCHEDULE` and its time zone from `STAY_GREEN_TIME_ZONE`, while the Worker reads `SCHEDULE` and `TIME_ZONE` from `worker/wrangler.jsonc`.

| Setting | Default | Format |
|---|---|---|
| `STAY_GREEN_SCHEDULE`, `SCHEDULE` | `Mon-Fri 09:00-18:00`, in the script and in the Worker. | Rules separated by `;`. |
| `STAY_GREEN_TIME_ZONE`, `TIME_ZONE` | The script uses the computer's time zone. The Worker uses UTC. | An IANA time zone name in its exact case, such as `Europe/Istanbul`. |

Both `systemd/stay-green.service` and `worker/wrangler.jsonc` ship with the schedule `Mon-Fri 09:00-18:00` and the time zone `Europe/Istanbul`. Change both before you start the timer or deploy the Worker.

Each rule consists of a day list, a single space, and a time-range list:

- Day names are case-sensitive (`Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`, `Sun`). Inclusive day ranges such as `Mon-Fri` can wrap across the weekend (`Fri-Mon`), and commas join multiple days or ranges without spaces (`Mon,Wed,Fri-Sat`).
- Time ranges use `HH:MM-HH:MM` with two-digit hours and minutes, include the start minute, and exclude the end minute, so `09:00-18:00` matches 09:00 through 17:59. `24:00` is valid as an end time, commas join multiple ranges on the same day, and ranges that cross midnight require two separate rules.
- Multiple rules that match the same day combine their time ranges.

Examples:

| Schedule | Covers |
|---|---|
| `Mon-Fri 09:00-18:00` | Weekdays from 09:00 to 17:59. |
| `Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00` | A lunch break Monday to Thursday, and a short Friday. |
| `Sun-Thu 08:00-17:00` | A Sunday to Thursday week. |

Each run evaluates the schedule against the current wall-clock time in the configured time zone, so daylight saving transitions need no schedule changes. The script and the Worker both check the schedule again right before they call `setPresence`.

## Files

The script stores state in `$XDG_STATE_HOME/stay-green/`, or `~/.local/state/stay-green/` when `XDG_STATE_HOME` is unset, creating the directory with mode 700 and each file with mode 600. `login` also sets an existing directory to mode 700.

| File | Content |
|---|---|
| `refresh-token` | The refresh token, as text. Each renewal replaces it. |
| `access-token` | JSON with `token`, the access token, and `expires`, its expiry as a Unix time in seconds. The script uses it until 5 minutes before `expires`. A missing or damaged file means a renewal. |
| `lock` | Empty. `login`, `run`, and `status` hold it with `flock` while they read or replace the stored tokens, so a renewal that is in progress cannot write the old tokens over a new sign-in. |
| `.image-checked` | Written only by `systemd/stay-green-container`. Its modification time is the time of the last image check. |
| `renewal-failed` | The error of a renewal that the sign-in service refused. While this file exists and the access token has expired, each run fails without contacting Microsoft. `login` deletes it. |

Microsoft's token endpoint refuses a renewal when it responds with `invalid_grant`, `interaction_required`, `consent_required`, `invalid_client`, or `unauthorized_client`. Transient failures such as network errors, HTTP 429 or 5xx responses, or error pages without an OAuth error code fail that run without recording a refused renewal.

## systemd units

`systemd/stay-green.timer` triggers `stay-green.service` on `OnCalendar=*-*-* *:00/4:00` (every 4 minutes around the clock) with `AccuracySec=10s` so each invocation starts within 10 seconds of its scheduled mark. Because the unit omits `Persistent=`, systemd does not replay missed runs after the machine powers back on.

`systemd/stay-green.service` runs as a `oneshot` unit with `ExecStart=%h/stay-green/stay-green run`, `TimeoutStartSec=2min`, and two `Environment=` assignments (`STAY_GREEN_SCHEDULE=Mon-Fri 09:00-18:00` and `STAY_GREEN_TIME_ZONE=Europe/Istanbul`).

## Worker settings

`worker/wrangler.jsonc` configures the Cloudflare Worker:

| Setting | Value |
|---|---|
| `triggers.crons` | `*/4 * * * *`, in UTC. |
| `vars.SCHEDULE` | The schedule. The shipped value is `Mon-Fri 09:00-18:00`. |
| `vars.TIME_ZONE` | The time zone of the schedule. The shipped value is `Europe/Istanbul`. |
| `kv_namespaces` | The `TOKENS` binding, with no `id`. The first `wrangler deploy` creates a namespace named `stay-green-tokens`, and later deploys reuse it. |
| `workers_dev`, `preview_urls` | `false`. The Worker has no URL. |
| `observability.enabled` | `true`, so Workers Logs keeps each run's log lines. |

Invocations outside the schedule return before reading Workers KV.

The `TOKENS` KV namespace stores two keys:

| Key | Content |
|---|---|
| `refresh-token` | The refresh token, as text. You upload the first one, and each renewal replaces it. |
| `cache` | JSON with `hash`, the SHA-256 of the refresh token that the entry belongs to, and either `token` and `expires`, the access token and its expiry in Unix milliseconds, or `rejected`, the error of a refused renewal. The Worker ignores the entry when `hash` does not match the current refresh token. |

## Requests to Microsoft

Every request authenticates as Microsoft Graph Command Line Tools (client ID `14d82eec-204b-4c2f-b7e8-296a70dab67e`) with the scope `offline_access https://graph.microsoft.com/Presence.ReadWrite`.

| Request | When |
|---|---|
| `GET https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize` | Once, at `login`. The script opens it in your browser. |
| `POST https://login.microsoftonline.com/organizations/oauth2/v2.0/token` with `grant_type=authorization_code` | Once, at `login`. The request uses PKCE. |
| `POST https://login.microsoftonline.com/organizations/oauth2/v2.0/token` with `grant_type=refresh_token` | When the access token expires within 5 minutes, about once an hour. |
| `GET https://graph.microsoft.com/v1.0/me/presence` | At each `run` inside the schedule, and at each `status`. |
| `POST https://graph.microsoft.com/v1.0/users/{id}/presence/setPresence` | At each `run` inside the schedule that is not out of office. |

The `setPresence` request body is:

```json
{
	"sessionId": "14d82eec-204b-4c2f-b7e8-296a70dab67e",
	"availability": "Available",
	"activity": "Available",
	"expirationDuration": "PT15M"
}
```

## Logs

| Where it runs | How to read the log |
|---|---|
| systemd | `journalctl --user -u stay-green.service` |
| Cloudflare Worker | `npx wrangler@4 tail` from the `worker` folder, or **Observability** on the Worker's dashboard page. The free plan keeps logs for 3 days. |

Each successful run inside the schedule logs one of three lines:

| Line | Meaning |
|---|---|
| `marked Available; the status was <availability>` | stay-green called `setPresence`. The availability is the one from before the call. |
| `out of office; left the status at <availability>` | Graph reported you out of office, so stay-green made no call. |
| `the schedule ended during this run; left the status at <availability>` | The run started inside the schedule and reached `setPresence` after it ended, so stay-green made no call. |

Runs outside the schedule emit no stay-green log line.

## Errors

The Python script writes expected errors to standard error as a single line prefixed with `stay-green:`, whereas the Worker throws an exception that surfaces in the Worker log.

| Error | Cause | Recovery |
|---|---|---|
| `no sign-in in <path>; sign in with: stay-green login` | The state folder has no `refresh-token`. | `stay-green login`, or `stay-green login HOST` from a computer with a browser. |
| `no refresh-token key in TOKENS; ...` | Worker only. The namespace has no `refresh-token` key. | An upload, as in [the Workers guide](how-to-run-on-cloudflare-workers.md#upload-the-refresh-token). |
| `the sign-in was rejected earlier (<error>)` | An earlier renewal was refused, and stay-green does not repeat a refused renewal. | A new sign-in. |
| `400 invalid_grant: AADSTS...` | The refresh token expired or was revoked, or a policy refused the renewal. The next run fails with `the sign-in was rejected earlier`. | A new sign-in. If it fails the same way, the AADSTS code in [Microsoft's error code list](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes) names the cause. |
| `400 interaction_required: AADSTS...` | The renewal needs another sign-in step, such as multifactor authentication. | A new sign-in. |
| `401 ...` from Graph | Graph rejected the access token, such as after a revocation. stay-green deletes the cached access token. | The next run renews the access token. If Microsoft refuses that renewal, the sign-in errors above apply. |
| `403 ...` or `404 ...` from Graph | Graph refused the request, such as for a missing permission. Graph errors never mark the renewal as refused. | The next run tries again. If the error repeats, a new sign-in, or an admin who allows `Presence.ReadWrite`. |
| `0 unreachable: ...` | No answer: a DNS or connection error, a dropped connection, or a timeout. | The next run tries again. |
| `0 not-json: the answer is not a JSON object` | A successful answer that is not a JSON object, such as a proxy's login page. | The next run tries again. |
| `429 ...` or `5xx ...`, or `<status>: the answer has no error code` | Microsoft or a proxy throttled or failed the request. | The next run tries again. |
| `unknown day in STAY_GREEN_SCHEDULE: ...`, `bad time range in STAY_GREEN_SCHEDULE: ...`, or the same with `SCHEDULE` | The schedule does not match the format. | A corrected schedule. |
| `unknown time zone in STAY_GREEN_TIME_ZONE: ...`, or `Invalid time zone specified: ...` in the Worker | The time zone is not an IANA name. | A corrected time zone. |
| `no sign-in within 5 minutes` | `login` got no redirect from the browser in time. | Another `login`. |
| `sign-in failed: <error>: <description>` | The Microsoft sign-in page returned an error, such as a refused consent. | The description names the cause. An admin may have to allow the app or the permission. |
| `the sign-in did not grant Presence.ReadWrite: <scopes>` | The sign-in succeeded without the permission that stay-green needs. | An admin who allows `Presence.ReadWrite` for Microsoft Graph Command Line Tools. |
| `could not store the sign-in on <HOST>` | The `ssh` command failed, the connection dropped, or `HOST` has no `flock` or `mktemp`. When the connection dropped before the whole token arrived, the token stored before stays as it was. When it dropped after, the new token may be stored. | Another `login HOST` once `ssh HOST` works from this computer, which is safe in both cases. |
| `cannot open <folder>/lock: <reason>` | This user cannot write to the state folder, so stay-green cannot take its lock. | Write access to the state folder for the user that runs stay-green. |
