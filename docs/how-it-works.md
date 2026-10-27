# How stay-green keeps the status Available

Teams tracks a separate presence session for each open Teams client, and Microsoft Graph lets an app keep one more beside them. Teams shows whichever session has the highest precedence. stay-green holds that app session and renews it as Available during your working hours, so your Teams clients can sit idle, locked, or closed.

## Teams shows the session with the highest precedence

Microsoft documents the precedence rules in [Manage presence state using the Microsoft Graph API](https://learn.microsoft.com/en-us/graph/cloud-communications-manage-presence-state):

- A status you pick in Teams overrides every session.
- Across sessions, Do not disturb outranks Busy, Busy outranks Available, and Available outranks Away.

An idle Teams client reports Away, while the stay-green session still reports Available and keeps your dot green. Joining a meeting or a call marks your Teams client Busy, which outranks Available and lets your colleagues see that you are in a meeting. Picking Do not disturb or Appear away in Teams overrides stay-green and every other session.

I built stay-green around [`setPresence`](https://learn.microsoft.com/en-us/graph/api/presence-setpresence?view=graph-rest-1.0) to preserve that hierarchy. Graph's other endpoint, [`setUserPreferredPresence`](https://learn.microsoft.com/en-us/graph/api/presence-setuserpreferredpresence?view=graph-rest-1.0), writes the user-selected status in Teams, which would mask your meetings and overwrite any status you picked by hand.

## An idle session fades in two steps

An Available session expires unless the app renews it. According to the same Microsoft page, an Available session times out five minutes after its last call and drops its activity to `AvailableInactive`, then drops to `Away` five minutes after that. My server's journal shows both transitions, with Graph reporting the first step's availability as `AvailableIdle`: two runs that arrived 7 and 8 minutes after the preceding run saw `AvailableIdle`, and one run after a 12-minute gap saw `Away`.

Calling Graph every 4 minutes leaves a one-minute buffer before that first timeout, so a run that starts up to a minute late still lands before the session goes inactive.

Each call sets `expirationDuration` to 15 minutes, which is when Graph closes the session if no further calls arrive. That 15-minute window means a couple of missed runs during the day let the status fade for a few minutes without dropping the session altogether. On a schedule that ends at 18:00, the final run fires at 17:56, the session turns inactive around 18:01, switches to Away around 18:06, and closes around 18:11.

Teams clients poll for presence, so a change made through Graph can take a few minutes to show in Teams. Microsoft notes this on the same page.

## The schedule decides when it runs

The timer and the Worker trigger every 4 minutes around the clock, and each run checks your schedule first. Outside scheduled hours, the process exits before reading the refresh token or contacting Microsoft. You write the schedule as days and time ranges in an IANA time zone, such as `Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00` in `Europe/Istanbul`, so lunch breaks, early Fridays, and daylight saving transitions work without editing the systemd timer or the cron expression. Both the Linux script and the Cloudflare Worker parse the format defined in [the reference](reference.md#schedule).

## Out of office stops the calls

Each run inside your schedule reads your current presence before it calls `setPresence`. If Graph [reports out of office](https://learn.microsoft.com/en-us/graph/api/resources/outofofficesettings?view=graph-rest-1.0), stay-green skips the update and leaves your status untouched. Graph sets that flag during an out-of-office window configured in Outlook or Teams and during any calendar event marked Out of office.

## The sign-in uses Microsoft's own command-line app

Calling Graph on your behalf requires an access token with the delegated `Presence.ReadWrite` permission. Rather than registering a custom application in your organization's Microsoft Entra ID, stay-green signs in as Microsoft's pre-registered Microsoft Graph Command Line Tools app, client ID `14d82eec-204b-4c2f-b7e8-296a70dab67e`, which Microsoft lists among its [first-party apps](https://learn.microsoft.com/en-us/troubleshoot/azure/entra/entra-id/governance/verify-first-party-apps-sign-in).

Using that app solves three setup problems:

- Public client flows work without a client secret.
- The app accepts `http://localhost` redirects, so `stay-green login` can catch the sign-in redirect on a local port. While I found no Microsoft page listing the app's registered redirect URIs, Microsoft [ignores the port](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url) when matching a registered `http://localhost` URI, and `stay-green login` depends on that behavior.
- Microsoft's [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) marks delegated `Presence.ReadWrite` as not requiring admin consent, letting you grant it yourself unless your organization [turned user consent off](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent).

Because `setPresence` requires the calling app's client ID as its session ID, the presence session that stay-green keeps belongs to Microsoft Graph Command Line Tools.

A single interactive sign-in returns a refresh token that stay-green saves to disk or Workers KV. About once an hour, stay-green exchanges that refresh token for a fresh access token and stores the new refresh token that comes back with it. Refresh tokens expire after [90 days without use](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes), so regular workday renewals keep the token alive. A gap of 90 days or more, such as a long leave, requires a new `stay-green login`. See [the risks](risks.md) for what a stored refresh token permits and where those renewals appear in audit logs.

## stay-green needs no device that stays awake

Workarounds from the X thread in the README keep a Teams client awake, tying up a machine all day. stay-green replaces that open client with a small program that runs every 4 minutes and a stored refresh token. In exchange, your organization's sign-in logs record the token renewals, and an attacker who steals the refresh token can act as you. Read [the risks](risks.md) to weigh that trade against your employer's policies.
