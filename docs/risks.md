# The risks of keeping your status Available

stay-green makes Teams show you Available when you may not be at your desk. Beyond the workplace policy risk, your organization can spot the calls in its logs or block them with access policies, and someone who steals the stored refresh token can act as you.

## Your employer may treat it as misconduct

A green dot tells your colleagues that you are at your computer. Some employers treat a faked status the same way they treat any other falsified work record.

In May 2024, Wells Fargo fired more than a dozen employees in its wealth and investment management unit. Its FINRA filings, reported by [The Register](https://www.theregister.com/on-prem/2024/06/13/wells-fargo-fires-employees-for-faking-keyboard-activity/771827) and [Banking Dive](https://www.bankingdive.com/news/wells-fires-employees-faking-productivity-finra/719033/) in June 2024, stated that they were "discharged after review of allegations involving simulation of keyboard activity creating impression of active work". While the filings do not name the tools those employees used, the allegation centered on faking a sign of activity, which is what stay-green does.

Check your employer's policy before you run it. If the policy requires your status to reflect your real activity, stay-green violates it.

## Your organization can find it

An admin who checks Entra logs can find stay-green in two places:

- Sign-in logs record each token renewal as a non-interactive sign-in by "Microsoft Graph Command Line Tools", about once an hour during your schedule. [Microsoft's page on non-interactive sign-ins](https://learn.microsoft.com/en-us/entra/identity/monitoring-health/concept-noninteractive-sign-ins) includes refresh token renewals and notes that each entry logs the app, the user, and the IP address.
- Graph activity logs, when enabled on a Microsoft Entra ID P1 or P2 tenant, record each Graph request, including the `setPresence` call every 4 minutes with its app ID and IP address. [Microsoft Graph activity logs](https://learn.microsoft.com/en-us/graph/microsoft-graph-activity-logs-overview) lists the captured fields.

## Identity Protection may flag the renewals

On tenants with Microsoft Entra ID P2, [Identity Protection](https://learn.microsoft.com/en-us/entra/id-protection/concept-identity-protection-risks) watches for sign-ins outside your normal pattern. Running stay-green in a data center can trigger two of its detections:

- "Unfamiliar sign-in properties" compares the IP address, network, and location against your sign-in history. Microsoft notes that when this detection fires on a non-interactive sign-in, "it deserves increased scrutiny due to the risk of token replay attacks".
- "Anomalous token" flags refresh tokens "played from an unfamiliar location".

Signing in on your own computer and renewing from a Cloudflare or Google data center matches the traffic pattern of a stolen refresh token. A risk policy can respond by blocking the renewals, forcing a password reset, or alerting your security team. Running stay-green on a Linux box at home keeps the renewals on your home IP address.

## Your organization can block it

An admin can stop stay-green with any of four controls:

- Require a compliant device, or a device joined to your organization, in a [Conditional Access](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-conditional-access-grant) policy, which rules out a Linux server or a Cloudflare Worker.
- Restrict allowed [network locations](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-assignment-network) in Conditional Access, which Microsoft re-evaluates at each refresh token renewal, by default once an hour.
- Turn on "Assignment required" or disable sign-in on the Microsoft Graph Command Line Tools enterprise app, as [Microsoft describes](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users).
- [Turn off user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent) for the tenant so that an admin must grant `Presence.ReadWrite` before you can sign in.

Any of those controls causes token renewal to fail on each run until the restriction ends. If Microsoft rejects the renewal with one of the five error codes in [the reference](reference.md#files), stay-green stops retrying until you sign in again.

## A stolen refresh token acts as you

Microsoft's [Refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens) and [Configurable token lifetimes](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes) pages document three properties that matter here:

- A refresh token is bound to you and the client app rather than to a single resource, so its holder can get access tokens for any permission you have granted to Microsoft Graph Command Line Tools. If you ever granted `Mail.Read` to that app, the same token can read your mail.
- A refresh token expires after 90 days without use, and each renewal returns a replacement token, so a token that stay-green keeps renewing does not expire.
- Renewing a refresh token does not invalidate the previous one, which means a stolen copy remains valid until its own lifetime runs out.

Treat the refresh token like a password. On a Linux box, stay-green writes the token file with mode 600 so other local users cannot read it. On Cloudflare, the token sits in a Workers KV namespace readable by any user with access to your Cloudflare account, so protect that account with a strong password and two-factor authentication.

If you suspect someone copied the refresh token, ask your admin to revoke your refresh tokens rather than relying on a password change. As Microsoft's refresh token page notes, changing your password revokes refresh tokens issued after a password sign-in, not those issued after a passwordless sign-in such as a passkey. Your admin can invalidate all of your refresh tokens with **Revoke sessions** on your user account in the Microsoft Entra admin center, as [Revoke user access](https://learn.microsoft.com/en-us/entra/identity/users/users-revoke-access) describes. Once revoked, stay-green fails until you sign in again.

## Free hosts can stop it

A hosting provider can suspend your jobs or close your account if your workload breaks its terms of service. GitHub's terms state that on GitHub-hosted runners, Actions should not be used for activity unrelated to the repository's software project, which is one reason [where to run it for free](where-to-run-it-for-free.md) rules out GitHub Actions.
