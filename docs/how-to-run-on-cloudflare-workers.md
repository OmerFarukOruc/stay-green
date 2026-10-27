# Run stay-green on Cloudflare Workers

This guide runs stay-green as a Cloudflare Worker on the Workers free plan, for when you have no computer that stays on. A Cron Trigger starts the Worker every 4 minutes, the Worker checks your schedule, and it keeps the refresh token in Workers KV.

You need:

- A Cloudflare account. The free plan is enough.
- Node.js 22 or newer on your computer, for Wrangler, the Cloudflare command-line tool.
- Python 3.9 or newer and a browser on your computer, to sign in.
- A work or school Microsoft 365 account. Graph does not let an app set the presence of a personal Microsoft account.

The commands are for a Linux shell. Read [the risks](risks.md) before you start. A Worker renews from Cloudflare's data centers, and Microsoft's Identity Protection, its sign-in risk detection, can flag that.

## Get the code

```sh
git clone https://github.com/OmerFarukOruc/stay-green
cd stay-green
```

Run the commands in this guide from the `stay-green` folder.

## Sign in on your computer

The Worker cannot run the sign-in, because the sign-in sends its result to `http://localhost` on the computer that signs in. So you sign in on your computer and upload the refresh token.

```sh
python3 stay-green login
```

Sign in with your work account. If Microsoft asks you to accept the permissions, accept them. The script stores the refresh token in `~/.local/state/stay-green/refresh-token`, or under `$XDG_STATE_HOME` if you set it, and prints `Stored the sign-in in ...`.

Check that the sign-in works:

```sh
python3 stay-green status
```

The first line shows your availability and activity, such as `Available / Available`.

## Set your schedule

Edit `vars` in `worker/wrangler.jsonc`:

```jsonc
"SCHEDULE": "Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00",
"TIME_ZONE": "America/New_York",
```

`SCHEDULE` lists days and time ranges. A range ends before its end time. [The reference](reference.md#schedule) defines the format. `TIME_ZONE` is an IANA time zone name.

To check both values before you deploy, run `status` with them:

```sh
STAY_GREEN_SCHEDULE='Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00' \
STAY_GREEN_TIME_ZONE=America/New_York python3 stay-green status
```

The second line says whether now is inside the schedule. A mistake in either value makes `status` fail with a message that names the wrong part.

## Deploy the Worker

Log in to Cloudflare, then deploy:

```sh
(cd worker && npx wrangler@4 login)
(cd worker && npx wrangler@4 deploy)
```

The first deploy creates a KV namespace named `stay-green-tokens` for the `TOKENS` binding. When you run it in a terminal, Wrangler also writes the namespace ID into `worker/wrangler.jsonc`. Later deploys reuse the namespace with or without that ID.

A Cron Trigger needs a `workers.dev` subdomain on your account, even though this Worker has no URL. If the deploy fails with `You need a workers.dev subdomain`, open **Workers & Pages** in the Cloudflare dashboard once, which creates the subdomain, and deploy again.

Until you upload the refresh token in the next step, each run inside your schedule fails with `no refresh-token key in TOKENS`.

## Upload the refresh token

Upload the refresh token. When the upload succeeds, the command deletes the copy on your computer:

```sh
(cd worker && npx wrangler@4 kv key put refresh-token --binding TOKENS --path "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green/refresh-token" --remote) \
	&& rm -r "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green"
```

The `--remote` flag matters. Without it, Wrangler 4 writes to a local copy of the namespace, which the deployed Worker never reads.

## Watch the runs

After the first deploy, the Cron Trigger can take up to [15 minutes](https://developers.cloudflare.com/workers/configuration/cron-triggers/) to start. Then, inside your schedule, stream the Worker's log:

```sh
(cd worker && npx wrangler@4 tail)
```

Every 4 minutes, a run logs a line such as `marked Available; the status was Away`. Outside your schedule, each run still appears in the log, but without a stay-green line. On the free plan, [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) also keeps these logs for 3 days. To read them in the Cloudflare dashboard, open the Worker and select **Observability**.

## Sign in again

When a run fails with `the sign-in was rejected earlier`, or when you want another account, sign in again and upload the new refresh token. Do it outside your schedule, and at least a minute before it starts. A run that is in progress during the upload, or that reads KV before the upload reaches its Cloudflare location, can write its own renewed refresh token over yours.

```sh
python3 stay-green login
(cd worker && npx wrangler@4 kv key put refresh-token --binding TOKENS --path "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green/refresh-token" --remote) \
	&& rm -r "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green"
```

The Worker detects that the refresh token changed, so it drops the old access token and the old rejection by itself.

## Update the Worker

Pull the repository and deploy again. Your edits to `vars`, and the namespace `id` if Wrangler wrote one, make `worker/wrangler.jsonc` a changed file. `git stash` sets them aside during the pull, and `git stash pop` puts them back:

```sh
git stash
git pull
git stash pop
(cd worker && npx wrangler@4 deploy)
```

If `git stash pop` reports a conflict in `worker/wrangler.jsonc`, keep your `vars` and any `id` in the file, then deploy.

## Remove the Worker

Delete the Worker, then the namespace that holds the refresh token:

```sh
(cd worker && npx wrangler@4 delete)
(cd worker && npx wrangler@4 kv namespace delete stay-green-tokens)
```

If Wrangler wrote an `id` under `kv_namespaces` in `worker/wrangler.jsonc`, delete that `id`, so that a later deploy creates a new namespace. The deleted refresh token stays valid at Microsoft until it expires. To make every copy useless, ask your admin to revoke your refresh tokens, as [the risks](risks.md#a-stolen-refresh-token-acts-as-you) describe.
