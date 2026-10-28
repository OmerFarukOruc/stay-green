# stay-green

stay-green keeps your Microsoft Teams status on Available, the green dot, during the working hours you choose. Every 4 minutes it tells Microsoft Graph that its own presence session is Available. Teams shows the session with the highest precedence, so you can close the Teams client and let your laptop sleep without a mouse jiggler or a spare device left awake.

## Why I built it

In October 2026, [a post on X](https://x.com/Omgemeraldddd/status/2111240896750698858) complained that Teams turns your status yellow after 5 minutes without mouse movement and gives you no setting to stop it. The replies suggested a mouse jiggler, a weight on the Caps Lock key, a solo meeting, a phone with Teams open and auto-lock off, or a YouTube video playing beside Teams in the browser. Every one of those tricks ties up a device that has to stay on and awake all day.

I had run into the same timeout and solved it without keeping a machine awake. I cleaned up my script and put it here so you can run it too.

## What it does

Teams keeps a separate presence session for each open Teams client, and Microsoft Graph lets an app hold one of its own. stay-green signs in once as Microsoft's "Microsoft Graph Command Line Tools" app and marks that app's session Available every 4 minutes. Because Available outranks Away, locking your laptop or quitting Teams no longer turns your dot yellow.

Your real activity still comes through:

- A meeting or a call marks your Teams session Busy, which has precedence over Available.
- A status you pick in Teams, such as Do not disturb or Appear away, overrides all sessions.
- An out-of-office window in Outlook or Teams, or a calendar event shown as Out of office, pauses stay-green so it makes no call.

You write your working days and hours in a single schedule string, with breaks or shorter days where you need them:

```text
Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00
```

A second setting takes the schedule's IANA time zone name, such as `Europe/Istanbul`. Outside your scheduled hours, stay-green stops calling Graph, and Teams falls back to your own status within 15 minutes as the last session expires.

Read [how it works](docs/how-it-works.md) for the session rules and the timeouts behind the 4-minute interval.

## How I run it

I run stay-green on a small Linux server that stays on all day for other work. A systemd timer starts it every 4 minutes on weekdays from 09:00 to 17:56 Istanbul time inside a throwaway rootless Podman container. My install still uses the project's first name, `teams-available`, and a fixed timer instead of the schedule setting.

Over 10 working days from 2026-10-14 to 2026-10-27, the timer completed 1,347 runs and failed to start three times. Before each call, Graph reported this availability:

| Availability before the call | Runs |
|---|---|
| `Available` | 1,271 |
| `Busy` | 59 |
| `Away` | 8 |
| `DoNotDisturb` | 5 |
| `AvailableIdle` | 2 |
| `Offline` | 2 |

In the `Busy` and `DoNotDisturb` runs, I was in a meeting or a call, or I had set a status by hand. Teams kept showing that status because it has precedence over Available. Nine of the 10 `Away` and `Offline` runs were the 09:00 run that starts the day, after nothing had renewed the session overnight.

During working hours, 3 gaps between runs exceeded 5 minutes: 7, 8, and 12 minutes. The 7-minute and 8-minute gaps left the session at `AvailableIdle`, while the 12-minute gap let it drop to `Away`, the single run among the 10 `Away` and `Offline` runs that occurred mid-day. Both steps match the timeouts that Microsoft documents, as [how it works](docs/how-it-works.md#an-idle-session-fades-in-two-steps) explains.

These two commands produced the counts on my server. Because my older container wrapper logs each status line twice, `-t teams-available-container` filters out the duplicate. On your own install, query `stay-green.service` and omit `-t`:

```sh
journalctl --user -u teams-available.service -t teams-available-container --since 2026-10-13 --until 2026-10-28 -o cat \
	| grep -o 'the status was [A-Za-z]*' | sort | uniq -c
journalctl --user -u teams-available.service --since 2026-10-13 --until 2026-10-28 -o cat | grep -c 'Failed to start'
```

On 2026-10-27 I tested the Cloudflare Worker with my own sign-in across 8 consecutive runs. Each run logged `marked Available; the status was Available` and used 4 to 9 ms of CPU time, close to the free plan's 10 ms ceiling.

## Run it yourself

Read [the risks](docs/risks.md) before you set it up. stay-green fakes your presence, leaves token renewals in your organization's sign-in logs, and stores a refresh token that can act as you.

You need a work or school Microsoft 365 account and a computer with a browser and Python 3.9 or newer for the initial sign-in. Pick where the job runs:

- [Run stay-green on a Linux box](docs/how-to-run-on-a-linux-box.md) if you have a Raspberry Pi, a home server, or a free Google Cloud VM.
- [Run stay-green on Cloudflare Workers](docs/how-to-run-on-cloudflare-workers.md) if you have no machine that stays on.

See [where to run it for free](docs/where-to-run-it-for-free.md) for how those two compare with GitHub Actions, Google Apps Script, Oracle Cloud, AWS, an Android phone, and Vercel. See [the reference](docs/reference.md) for the CLI commands, schedule syntax, state files, settings, log lines, and error messages.

## Tests

The tests use no fakes. They run the script and the Worker against the real Microsoft sign-in service and Graph, but they never sign in. The tokens they store are made up, so Microsoft refuses them, and the tests check what stay-green does with those real answers: the refusal mark, the cached access token, the schedule, and for the script a failed network. The one thing a test sets is the clock, in the script's schedule tests, so they can check daylight saving changes on fixed dates.

- Run the script's tests with `STAY_GREEN_TEST_SSH_HOST=localhost python3 -m unittest discover -s tests -v`. The `login HOST` tests send the store command through a real SSH server on your own computer, and they skip when the variable is unset.
- Run the Worker's tests with `npm ci` and then `npm test` on Node 22. They start the Worker in `wrangler dev`, the local Workers runtime, with a local KV namespace.

GitHub Actions runs both on every push to `main` and on every pull request.

Only a signed-in account can show the rest, so the tests leave it out. The runs on my own server and on Cloudflare described above show a sign-in, renewals that succeed, and setPresence. Nothing automated covers the out-of-office skip, the second schedule check before setPresence, or the refusal codes other than `invalid_grant`.

## License

[MIT](LICENSE)
