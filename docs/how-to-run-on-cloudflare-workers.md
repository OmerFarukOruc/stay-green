# Run stay-green on Cloudflare Workers

Deploy stay-green as a Cloudflare Worker on the Workers free plan when you have no computer that stays on during the day. A Cron Trigger starts the Worker every 4 minutes, the Worker checks your schedule, and Workers KV stores the refresh token.

You need:

- A Cloudflare account on the free plan or higher.
- Node.js 22 or newer on your computer to run Wrangler, Cloudflare's command-line tool.
- Python 3.14 or newer and a browser on your computer for the initial sign-in.
- A work or school Microsoft 365 account. Microsoft Graph does not allow an app to set the presence of a personal Microsoft account.

All commands below assume a Linux shell. Read [the risks](risks.md) before you start: a Worker renews tokens from Cloudflare's data centers, which Microsoft Entra Identity Protection can flag as a sign-in risk.

## Get the code

Clone the repository and enter the `stay-green` folder, where all commands in this guide run:

```sh
git clone https://github.com/OmerFarukOruc/stay-green
cd stay-green
```

## Sign in on your computer

Because the sign-in flow redirects to `http://localhost` on the machine with the browser, the Worker cannot run it. Sign in on your computer first, then upload the resulting refresh token:

```sh
python3 stay-green login
```

Sign in with your work account and accept the permission prompt if Microsoft shows one. The script saves the refresh token to `~/.local/state/stay-green/refresh-token`, or under `$XDG_STATE_HOME` when set, and prints `Stored the sign-in in ...`.

Verify the sign-in with `status`:

```sh
python3 stay-green status
```

The first line prints your current availability and activity, such as `Available / Available`.

## Set your schedule

Edit `vars` in `worker/wrangler.jsonc`:

```jsonc
"SCHEDULE": "Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00",
"TIME_ZONE": "America/New_York",
```

`SCHEDULE` defines your working days and time ranges using the syntax in [the schedule reference](reference.md#schedule), and a range ends before its end time. `TIME_ZONE` takes an IANA time zone name.

Before deploying, test both settings on your computer with `status`:

```sh
STAY_GREEN_SCHEDULE='Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00' \
STAY_GREEN_TIME_ZONE=America/New_York python3 stay-green status
```

The second line reports whether the current time falls inside the schedule, and any syntax error in either value makes `status` exit with a message naming the bad part.

## Deploy the Worker

Authenticate Wrangler with your Cloudflare account and deploy the Worker:

```sh
(cd worker && npx wrangler@4 login)
(cd worker && npx wrangler@4 deploy)
```

On the first deploy, Wrangler creates a KV namespace named `stay-green-tokens` for the `TOKENS` binding and, in an interactive terminal, writes its namespace ID into `worker/wrangler.jsonc`. Later deploys reuse that namespace whether or not the ID stays in the file.

Cloudflare requires an active `workers.dev` subdomain on your account before it attaches a Cron Trigger, even though this Worker disables public URLs. If `wrangler deploy` fails with `You need a workers.dev subdomain`, open **Workers & Pages** in the Cloudflare dashboard once to create the subdomain, then run `deploy` again.

Until you upload the refresh token in the next step, scheduled runs inside your working hours fail with `no refresh-token key in TOKENS`.

## Upload the refresh token

Upload the refresh token to Workers KV, and delete the local copy once the upload succeeds:

```sh
(cd worker && npx wrangler@4 kv key put refresh-token --binding TOKENS --path "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green/refresh-token" --remote) \
	&& rm -r "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green"
```

Keep the `--remote` flag on `kv key put`: without it, Wrangler 4 writes to a local development store that the deployed Worker cannot read.

## Watch the runs

After the initial deploy, Cloudflare can take up to [15 minutes](https://developers.cloudflare.com/workers/configuration/cron-triggers/) to register the Cron Trigger. Once it is active, stream the Worker's live log during your scheduled hours:

```sh
(cd worker && npx wrangler@4 tail)
```

Every 4 minutes inside your schedule, the Worker logs a line such as `marked Available; the status was Away`. Outside your schedule, the cron invocation still appears in the stream without a stay-green message. On the free plan, [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) retains these entries for 3 days under **Observability** on the Worker's dashboard page.

## Sign in again

To recover from `the sign-in was rejected earlier` or switch accounts, run a fresh sign-in and upload the new refresh token while no run can touch the stored one. Outside your schedule, each run ends before it reads KV, so the schedule works as the pause:

- Start at least 2 minutes after your schedule ends. A run that started inside the schedule has finished by then, because it waits at most 30 seconds for each of its three requests to Microsoft.
- Finish at least a minute before your schedule starts again. Cloudflare says a KV change [can take 60 seconds or more](https://developers.cloudflare.com/kv/concepts/how-kv-works/) to reach every location.

A run that overlaps the upload can write a renewed copy of the old refresh token over yours, and KV has no lock that could stop it.

```sh
python3 stay-green login
(cd worker && npx wrangler@4 kv key put refresh-token --binding TOKENS --path "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green/refresh-token" --remote) \
	&& rm -r "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green"
```

Because the Worker hashes the current refresh token in its KV cache, uploading a new token invalidates the cached access token and any recorded rejection on its own.

## Update the Worker

Pull the latest commits and redeploy. Your schedule edits in `vars`, and any namespace `id` that Wrangler wrote, make `worker/wrangler.jsonc` a changed file. `git stash` sets them aside before the pull, and `git stash pop` puts them back afterward:

```sh
git stash
git pull
git stash pop
(cd worker && npx wrangler@4 deploy)
```

If `git stash pop` reports a merge conflict in `worker/wrangler.jsonc`, keep your `vars` block and any namespace `id`, then run `deploy`.

## Remove the Worker

Delete the deployed Worker and the KV namespace that holds the refresh token:

```sh
(cd worker && npx wrangler@4 delete)
(cd worker && npx wrangler@4 kv namespace delete stay-green-tokens)
```

If Wrangler wrote an `id` under `kv_namespaces` in `worker/wrangler.jsonc`, remove that `id` line so a future deploy creates a new namespace. Deleting the KV namespace does not invalidate the refresh token at Microsoft before its expiration date. To invalidate every copy at once, ask your admin to revoke your refresh tokens, as [the risks](risks.md#a-stolen-refresh-token-acts-as-you) describe.
