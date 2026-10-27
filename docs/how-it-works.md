# How stay-green keeps the status Available

Teams does not keep one status for you. It keeps a presence session for each Teams client you have open, and Microsoft Graph lets an app keep its own session beside them. Teams shows the session with the highest precedence. stay-green owns one of those sessions and keeps it Available in your working hours, so the Teams clients can sit idle, locked, or closed.

## Teams shows the session with the highest precedence

Microsoft documents the order in [Manage presence state using the Microsoft Graph API](https://learn.microsoft.com/en-us/graph/cloud-communications-manage-presence-state):

- A status you pick in Teams has precedence over every session.
- Among sessions, Do not disturb has precedence over Busy, Busy over Available, and Available over Away.

When your Teams client reports Away, the stay-green session still says Available, so Teams shows you Available. When you are in a meeting, Teams shows you Busy, and Busy has precedence over Available, so your colleagues still see that you are in a meeting. When you pick Do not disturb or Appear away in Teams, your choice has precedence over everything stay-green does.

I picked [`setPresence`](https://learn.microsoft.com/en-us/graph/api/presence-setpresence?view=graph-rest-1.0) for that reason. Graph also has [`setUserPreferredPresence`](https://learn.microsoft.com/en-us/graph/api/presence-setuserpreferredpresence?view=graph-rest-1.0), which sets the status you pick in Teams. That call would hide your meetings, and it would overwrite the status you picked by hand.

## An idle session fades in two steps

A session does not stay Available forever. The same Microsoft page says that an Available session times out five minutes after the last call, and its activity changes to `AvailableInactive`. Five minutes later it changes to `Away`. The journal of the server I run stay-green on shows both steps, and in it Graph reported the availability of the first step as `AvailableIdle`. Two runs came 7 and 8 minutes after the run before them, and each saw the availability `AvailableIdle`. One run came after a 12-minute gap and saw `Away`.

So stay-green calls Graph every 4 minutes. That leaves one minute of margin, so a run that is up to a minute late still comes before the session goes inactive.

Each call also sets `expirationDuration` to 15 minutes. Graph ends the session that long after the last call. With 15 minutes, a few missed runs during the day only fade the session for a few minutes. At the end of a schedule that ends at 18:00, the last run is at 17:56. The session goes inactive at about 18:01 and Away at about 18:06, and Graph ends it at about 18:11.

Teams reads presence by polling, so a change made through Graph can take a few minutes to show in the Teams clients. Microsoft notes this on the same page.

## The schedule decides when it runs

stay-green starts every 4 minutes around the clock, and each run first checks your schedule. A run outside the schedule ends before it reads the refresh token or calls Microsoft. The schedule names days and time ranges in a time zone you choose, such as `Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00` in `Europe/Istanbul`. So a lunch break, a short Friday, or a daylight saving change needs no change to the timer or the cron. The Linux timer and the Cloudflare Worker read the same format, and [the reference](reference.md#schedule) defines it.

## Out of office stops the calls

Before each call, stay-green reads your presence. When Graph reports you out of office, stay-green skips the call and leaves your status alone. Graph [reports out of office](https://learn.microsoft.com/en-us/graph/api/resources/outofofficesettings?view=graph-rest-1.0) when the current time is inside an out-of-office window that you set in Outlook or Teams, or when a calendar event that shows as Out of office is in progress. So when either applies, stay-green makes no call, even inside your schedule.

## The sign-in uses Microsoft's own command-line app

To call Graph for you, stay-green needs an access token with the `Presence.ReadWrite` permission. stay-green does not register an app of its own in your organization's Microsoft Entra ID. It signs in as an app that Microsoft already provides, Microsoft Graph Command Line Tools, with the ID `14d82eec-204b-4c2f-b7e8-296a70dab67e`. Microsoft lists that ID among its [first-party apps](https://learn.microsoft.com/en-us/troubleshoot/azure/entra/entra-id/governance/verify-first-party-apps-sign-in).

That app suits stay-green for three reasons:

- It needs no client secret.
- It accepts a redirect to `http://localhost`, so `stay-green login` can receive the result of the sign-in on a port of your own computer. I found no Microsoft page that lists this app's redirect URIs. Microsoft [ignores the port](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url) when it matches a registered `http://localhost` redirect, and every `stay-green login` relies on that.
- The [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) marks the delegated `Presence.ReadWrite` permission as one that does not need admin consent. So you can consent to it yourself, unless your organization [turned user consent off](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent).

`setPresence` needs a session ID, and Microsoft asks for the app's ID there. So the session that stay-green keeps belongs to Microsoft Graph Command Line Tools.

You sign in once. The sign-in returns a refresh token. stay-green stores it and uses it to get a new access token about once an hour. Each renewal also returns a new refresh token, and stay-green keeps the newest one. A refresh token expires after [90 days without use](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes), so the renewals during your schedule keep it alive. If stay-green does not run for 90 days, for example during a long leave, the refresh token expires and you sign in again. [The risks](risks.md) explain what the stored refresh token can do and where the renewals show up.

## stay-green needs no device that stays awake

The replies to the post in the README keep a Teams client active, so each needs a device that stays on and awake all day. stay-green does not. It needs one small program that runs every 4 minutes somewhere, and a stored refresh token. Your organization's sign-in logs show the renewals, and a stored refresh token is something an attacker could use. Whether that trade suits you depends on your employer, so read [the risks](risks.md) before you decide.
