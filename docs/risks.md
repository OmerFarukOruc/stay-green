# The risks of keeping your status Available

stay-green makes Teams show you Available when you may not be at your desk. That is the point of it, and it is also the biggest risk. This page covers that risk first, then what your organization can see, what it can block, and what the stored refresh token can do if someone else gets it.

## Your employer may treat it as misconduct

A green dot tells your colleagues that you are at your computer now. Some employers treat a faked status like any other faked work record.

In May 2024, Wells Fargo fired more than a dozen employees in its wealth and investment management unit. Its FINRA filings said they were "discharged after review of allegations involving simulation of keyboard activity creating impression of active work". [The Register](https://www.theregister.com/on-prem/2024/06/13/wells-fargo-fires-employees-for-faking-keyboard-activity/771827) and [Banking Dive](https://www.bankingdive.com/news/wells-fires-employees-faking-productivity-finra/719033/) reported the filings in June 2024. The filings do not say which tools those employees used. The allegation was a faked sign of activity, and stay-green also produces a faked sign of activity.

Read your employer's policy before you run it. If the policy says that your status must reflect what you are doing, stay-green breaks it.

## Your organization can find it

An admin who looks can find stay-green in these places:

- Sign-in logs. Each renewal is a non-interactive sign-in by the app "Microsoft Graph Command Line Tools", about once an hour in your schedule. [Microsoft's page on non-interactive sign-ins](https://learn.microsoft.com/en-us/entra/identity/monitoring-health/concept-noninteractive-sign-ins) lists a refresh token renewal as one, and the log entry holds the app, the user, and the IP address.
- Graph activity logs. If your organization has Microsoft Entra ID P1 or P2 and an admin turned these logs on, they record every Graph request. That includes the `setPresence` call every 4 minutes, with the app ID and the IP address. [Microsoft Graph activity logs](https://learn.microsoft.com/en-us/graph/microsoft-graph-activity-logs-overview) lists the fields.

## Identity Protection may flag the renewals

With Microsoft Entra ID P2, [Identity Protection](https://learn.microsoft.com/en-us/entra/id-protection/concept-identity-protection-risks) looks for sign-ins that do not fit your usual pattern. Two of its detections fit stay-green when it runs in a data center:

- "Unfamiliar sign-in properties" compares the IP address, the network, and the location with your history. Microsoft says that when it fires on a non-interactive sign-in, "it deserves increased scrutiny due to the risk of token replay attacks".
- "Anomalous token" covers refresh tokens "played from an unfamiliar location".

You sign in on your own computer, and then the renewals come from a Cloudflare or Google data center. A stolen refresh token makes the same pattern. A risk policy can then block the renewals or make you change your password, and the security team may get an alert. A Linux box in your own home renews from your home IP address, which makes this pattern less likely.

## Your organization can block it

An admin can stop stay-green in several ways:

- A [Conditional Access](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-conditional-access-grant) policy that needs a compliant device or a device joined to the organization. A server or a Worker is neither.
- A Conditional Access policy that allows only some [network locations](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-assignment-network). Microsoft checks the location when a refresh token is renewed, by default once an hour.
- "Assignment required" on the Microsoft Graph Command Line Tools enterprise app, or sign-in turned off for that app. [Microsoft describes both settings](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users).
- [User consent turned off](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent) for the organization. Then you cannot consent to `Presence.ReadWrite` when you first sign in, and an admin has to.

When one of them applies, the renewal fails, and each run fails until the block ends. If Microsoft refuses the renewal with one of the five error codes in [the reference](reference.md#files), stay-green also stops asking until you sign in again.

## A stolen refresh token acts as you

Two Microsoft pages give the facts that matter here, [Refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens) and [Configurable token lifetimes](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes):

- A refresh token is bound to you and to the app, and not to one resource. Whoever holds it can get an access token for anything you consented to for Microsoft Graph Command Line Tools. If you ever consented to `Mail.Read` for this app, the refresh token can read your mail too.
- A refresh token expires after 90 days without use. Each renewal returns a new one, so a refresh token that stay-green keeps renewing does not expire.
- A renewal does not revoke the old refresh token. An old copy that someone took stays valid until it expires.

So keep the refresh token where you keep passwords. On a Linux box, stay-green writes it to a file with mode 600, so other users cannot read it. On Cloudflare, it sits in a Workers KV namespace that anyone with access to your Cloudflare account can read, so protect that account with a strong password and two-factor authentication.

If you think someone copied the refresh token, ask your admin to revoke your refresh tokens. A password change may not be enough. The refresh token page shows that a password change revokes the refresh token only when you signed in with a password, and not after a sign-in without one, such as with a passkey. The admin revokes all of your refresh tokens with **Revoke sessions** on your user in the Microsoft Entra admin center, as [Revoke user access](https://learn.microsoft.com/en-us/entra/identity/users/users-revoke-access) describes. After that, stay-green fails until you sign in again.

## Free hosts can stop it

A host can stop your jobs or your account when its terms forbid the use. GitHub's terms say that on GitHub-hosted runners, Actions should not be used for activity unrelated to the repository's software project. [Where to run it for free](where-to-run-it-for-free.md) rules out GitHub Actions for this reason among others.
