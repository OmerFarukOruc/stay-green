# Where to run stay-green for free

stay-green has to run every 4 minutes during your working hours on a host that can store a refresh token and overwrite it after each renewal. Running it on your own laptop defeats the purpose, because you need stay-green when that laptop sleeps or locks. I checked the free tiers below in October 2026 and ranked the working options from best to worst before listing the platforms I ruled out. Free tiers change, so verify the current limits on each linked vendor page before you rely on them.

## The places that run it

### 1. A Linux box you already have

A Raspberry Pi, a home server, or any Linux machine that stays on all day runs the Python script and the systemd timer as shipped, with no quota or expiration date. If you sign in and run the timer on the same home network, token renewals come from the home IP address your organization sees during your workday, whereas renewals from a cloud data center can resemble a stolen refresh token, as [the risks](risks.md) explain.

You pay for the electricity to keep the machine on. To set it up, follow [run stay-green on a Linux box](how-to-run-on-a-linux-box.md).

### 2. Cloudflare Workers

If you have no always-on machine at home, the Worker in `worker/` runs the same logic on the Cloudflare Workers free plan. Opening a Cloudflare account [requires an email address and a password](https://developers.cloudflare.com/fundamentals/account/create-account/). The free plan leaves a wide margin on requests, KV operations, and triggers, but CPU time per run comes close to its limit:

| Limit on the free plan | stay-green's use |
|---|---|
| [100,000 requests a day](https://developers.cloudflare.com/workers/platform/limits/) | 360 cron runs a day, one every 4 minutes |
| [10 ms of CPU time per cron run](https://developers.cloudflare.com/workers/platform/limits/) | In my test on 2026-10-27, 8 runs inside the schedule used 4 to 9 ms each, and runs outside it used 0 to 1 ms. Waiting for Microsoft does not count as CPU time. |
| [100,000 KV reads and 1,000 KV writes a day](https://developers.cloudflare.com/workers/platform/pricing/) | 2 reads a run in your schedule, and 2 writes for each hourly renewal |
| [5 Cron Triggers per account](https://developers.cloudflare.com/workers/platform/limits/) | 1 |

If a run exceeds the CPU limit, Cloudflare kills it and the next trigger retries 4 minutes later, leaving the presence session inactive for about 3 minutes in between. Because Cron Triggers use UTC, the Worker fires every 4 minutes around the clock and exits right away whenever the current time falls outside your schedule in your configured time zone.

The drawback is that token renewals come from Cloudflare's data centers. To deploy it, follow [run stay-green on Cloudflare Workers](how-to-run-on-cloudflare-workers.md).

### 3. A Google Cloud e2-micro VM

The [Google Cloud free tier](https://docs.cloud.google.com/free/docs/free-cloud-features) provides one non-preemptible e2-micro VM in `us-west1`, `us-central1`, or `us-east1`, paired with 30 GB of standard persistent disk and 1 GB of outbound traffic a month. Because stay-green sends a handful of tiny HTTPS requests per run, traffic over a month should stay well below 1 GB, though I have not measured it. The VM uses the Linux setup guide without changes.

Opening the account requires a Google Cloud billing account with a payment method on file, and all token renewals come from a Google data center in the United States.

## A place that needs a port

Google Apps Script executes JavaScript on a timer under a Google account, so the Worker could be ported to it. I have not written that port because two platform limits make Apps Script a worse fit than Cloudflare Workers:

- A time-driven trigger [can run every 1, 5, 10, 15, or 30 minutes](https://developers.google.com/apps-script/reference/script/clock-trigger-builder), and nothing in between: a 5-minute interval matches Graph's inactivity timeout, so the session can go inactive between runs, while running every minute makes 4 times as many calls.
- Google notes that a time-driven trigger's firing time [can vary by a small random offset](https://developers.google.com/apps-script/guides/triggers/installable).

## The places I ruled out

GitHub Actions is free on public repositories, but five constraints rule it out:

- [Scheduled workflows run at most every 5 minutes](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), which matches Graph's inactivity timeout, and GitHub warns that high load can delay or drop scheduled runs.
- In a private repository on the default schedule, running every 5 minutes across 9 hours produces 108 runs a day. Because GitHub [rounds each job's billable runtime up to a full minute](https://docs.github.com/en/billing/reference/actions-runner-pricing), 22 weekdays consume 2,376 minutes a month against [the free plan's 2,000-minute allowance](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
- Making the repository public removes the minute cap but exposes the workflow run logs to every GitHub user.
- Writing each new refresh token back to a repository secret requires a personal access token with secret-write permissions stored alongside it, because the workflow's own token cannot update secrets.
- [GitHub's Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features) say that GitHub-hosted runners should not be used for "any other activity unrelated to the production, testing, deployment, or publication of the software project associated with the repository where GitHub Actions are used", and keeping a Teams dot green is not building software.

Four other free options each hit a hard blocker:

- Oracle Cloud Always Free [can reclaim VMs it counts as idle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), defined as keeping both 95th-percentile CPU usage and network usage below 20% over a 7-day window. A VM dedicated to stay-green sits far below both thresholds.
- The AWS free tier [expires after six months or once its initial credits run out](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), whichever happens first, and closes the free account at that point.
- Android's `JobScheduler` enforces a minimum periodic interval of 15 minutes (`MIN_PERIOD_MILLIS` in [Android's `JobInfo` source](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/android-29/+/refs/heads/androidx-wear-release/android/app/job/JobInfo.java)), and [Doze mode](https://developer.android.com/training/monitoring-device-state/doze-standby) suspends background jobs and network access whenever the phone sleeps.
- Vercel's Hobby plan restricts cron jobs to [one invocation a day](https://vercel.com/docs/cron-jobs/usage-and-pricing).

I also checked Azure Functions, Deno Deploy, Netlify, and cron-job.org. Azure Functions requires both a [payment card](https://azure.microsoft.com/en-us/free/free-account-faq/) and a [storage account](https://learn.microsoft.com/en-us/azure/azure-functions/storage-considerations), while cron-job.org sends HTTP requests to a URL and still needs a backend host and token store. Deno Deploy and Netlify might work, but I have not tested either one.
