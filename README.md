# stay-green

stay-green keeps your Microsoft Teams status Available, the green dot, in the working hours you choose. It needs no Teams client, no mouse jiggler, and no device that stays awake. Every 4 minutes it tells Microsoft Graph that its own presence session is Available, and Teams shows the session with the highest precedence.

## Why I built it

In October 2026, [a post on X](https://x.com/Omgemeraldddd/status/2111240896750698858) complained that Teams turns your status yellow after 5 minutes without mouse movement, and that you cannot turn that off. The replies suggested a mouse jiggler, a weight on the Caps Lock key, a meeting with yourself, a phone with Teams open and auto-lock off, and a YouTube video next to Teams in the browser. Each of those needs a device that stays on and awake all day.

I had the same problem and had already solved it without a device. This repository is that solution, cleaned up so that anyone can run it.

## What it does

Teams keeps a presence session for each Teams client you have open, and Microsoft Graph lets an app keep one more. stay-green signs in once as Microsoft's own "Microsoft Graph Command Line Tools" app. It marks that app's session Available every 4 minutes. Available has precedence over Away, so a locked laptop or a closed Teams client no longer turns you yellow.

Your real status still shows:

- In a meeting or a call, Teams shows you Busy, and Busy has precedence over Available.
- A status you pick in Teams, such as Do not disturb or Appear away, has precedence over every session.
- When you set an out-of-office window in Outlook or Teams, or a calendar event shows as Out of office, stay-green makes no call.

You choose the days and hours in one line. You can add breaks and give one day different hours:

```text
Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00
```

You set the time zone of the schedule separately, with an IANA name such as `Europe/Istanbul`. Outside those hours, stay-green makes no calls, and Teams shows your own status again once the last call's session fades, within 15 minutes.

[How it works](docs/how-it-works.md) explains the sessions, the timeouts, and why the interval is 4 minutes.

## How I run it

A small Linux server of mine that is on all day anyway runs stay-green from a systemd timer. The timer starts it every 4 minutes on weekdays from 09:00 to 17:56 Istanbul time, each time in a throwaway rootless Podman container. My copy still has the project's first name, `teams-available`, and a fixed timer instead of a schedule.

From 2026-10-14 to 2026-10-27, 10 working days, the timer completed 1,347 runs. Three more runs failed to start. Before each call, Graph reported this availability:

| Availability before the call | Runs |
|---|---|
| `Available` | 1,271 |
| `Busy` | 59 |
| `Away` | 8 |
| `DoNotDisturb` | 5 |
| `AvailableIdle` | 2 |
| `Offline` | 2 |

`Busy` and `DoNotDisturb` mean that a meeting, a call, or a status I picked was in place. Teams kept showing it, because it has precedence over Available. Nine of the 10 `Away` and `Offline` runs were the first run of a day, at 09:00, when nothing had kept the status up overnight.

Within a day, only 3 gaps between runs were longer than 5 minutes: 7, 8, and 12 minutes. After the 7-minute and 8-minute gaps, the next run saw `AvailableIdle`. After the 12-minute gap, it saw `Away`. That was the only one of the 10 `Away` and `Offline` runs that did not start a day. That matches the timeouts that Microsoft documents, as [how it works](docs/how-it-works.md#an-idle-session-fades-in-two-steps) explains.

I counted the runs on the server with these commands. My server's older container script writes each status line twice, and `-t teams-available-container` keeps one of the two. On your own install, use `stay-green.service` and leave out `-t`.

```sh
journalctl --user -u teams-available.service -t teams-available-container --since 2026-10-13 --until 2026-10-28 -o cat \
	| grep -o 'the status was [A-Za-z]*' | sort | uniq -c
journalctl --user -u teams-available.service --since 2026-10-13 --until 2026-10-28 -o cat | grep -c 'Failed to start'
```

I also tested the Cloudflare Worker on 2026-10-27 with my own sign-in. Its 8 runs in a row each logged `marked Available; the status was Available`. Each run used 4 to 9 ms of CPU time, close to the free plan's limit of 10 ms.

## Run it yourself

Read [the risks](docs/risks.md) first. stay-green fakes a status, your organization can see the renewals in its logs, and the stored refresh token acts as you.

You need a work or school Microsoft 365 account, and Python 3.9 or newer on a computer with a browser to sign in. Then pick where it runs:

- [Run stay-green on a Linux box](docs/how-to-run-on-a-linux-box.md), such as a Raspberry Pi, a home server, or a free Google Cloud VM.
- [Run stay-green on Cloudflare Workers](docs/how-to-run-on-cloudflare-workers.md), when you have no computer that stays on.

[Where to run it for free](docs/where-to-run-it-for-free.md) compares those with GitHub Actions, Google Apps Script, Oracle Cloud, AWS, an Android phone, and Vercel. [The reference](docs/reference.md) lists the commands, the schedule format, files, settings, logs, and errors.

## License

[MIT](LICENSE)
