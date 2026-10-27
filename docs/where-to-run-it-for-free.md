# Where to run stay-green for free

stay-green has to run every 4 minutes in your working hours, from a place that can keep a refresh token and replace it after each renewal. Your own laptop is a poor place, because the reason you need stay-green is that your laptop sleeps or locks. This page ranks the free places that can run it, best first, and explains why I ruled out others. I checked the vendor pages in October 2026, and free plans change, so check the linked page before you rely on a limit.

## The places that run it

### 1. A Linux box you already have

A Raspberry Pi, a home server, or any Linux computer that stays on all day runs the Python script and the systemd timer unchanged. It has no quota and no expiry. It also renews from your home IP address, which is the address your organization already sees when you work from home, if you also sign in from there. That matters, because renewals from a data center can look like a stolen refresh token. [The risks](risks.md) explain why.

The cost is the power, and a box that has to stay on. Follow [run stay-green on a Linux box](how-to-run-on-a-linux-box.md).

### 2. Cloudflare Workers

If you have no box that stays on, the Worker in `worker/` runs the same logic on the Workers free plan. Signing up for Cloudflare [needs an email address and a password](https://developers.cloudflare.com/fundamentals/account/create-account/). The free plan's request, KV, and trigger limits leave a wide margin, but CPU time comes close to its limit:

| Limit on the free plan | stay-green's use |
|---|---|
| [100,000 requests a day](https://developers.cloudflare.com/workers/platform/limits/) | 360 cron runs a day, one every 4 minutes |
| [10 ms of CPU time per cron run](https://developers.cloudflare.com/workers/platform/limits/) | In my test on 2026-10-27, 8 runs inside the schedule used 4 to 9 ms each, and runs outside it used 0 to 1 ms. Waiting for Microsoft does not count as CPU time. |
| [100,000 KV reads and 1,000 KV writes a day](https://developers.cloudflare.com/workers/platform/pricing/) | 2 reads a run in your schedule, and 2 writes for each hourly renewal |
| [5 Cron Triggers per account](https://developers.cloudflare.com/workers/platform/limits/) | 1 |

Cloudflare stops a run that goes over the CPU limit, and the next run tries again 4 minutes later. After one stopped run, the session goes inactive for about 3 minutes.

Cron Triggers run in UTC, so the Worker starts every 4 minutes all day, and the code skips each run outside your schedule in your time zone.

The cost is that the renewals come from Cloudflare's data centers. Follow [run stay-green on Cloudflare Workers](how-to-run-on-cloudflare-workers.md).

### 3. A Google Cloud e2-micro VM

The [Google Cloud free tier](https://docs.cloud.google.com/free/docs/free-cloud-features) includes one e2-micro VM that does not get preempted, in `us-west1`, `us-central1`, or `us-east1`. It comes with 30 GB of standard disk and 1 GB of outbound traffic a month. stay-green sends a few small requests per run, so I expect it to stay far under 1 GB, but I have not measured it. The VM runs the Linux how-to unchanged.

It needs a Google Cloud billing account, so you give Google a payment method. The renewals come from a Google data center in the United States.

## A place that needs a port

Google Apps Script runs JavaScript on a timer with a Google account, so a port of the Worker could run there. This repository has no such port, and Apps Script has two limits that make it a weaker fit:

- A time-driven trigger [can run every 1, 5, 10, 15, or 30 minutes](https://developers.google.com/apps-script/reference/script/clock-trigger-builder), and nothing in between. Every 5 minutes equals the timeout after which Graph marks the session inactive, so the session would sometimes go inactive. Every minute works, but it makes 4 times as many calls.
- Google says the start time of a time-driven trigger [might be slightly randomized](https://developers.google.com/apps-script/guides/triggers/installable).

## The places I ruled out

GitHub Actions is free for public repositories, but it does not fit for these reasons:

- [The shortest schedule is every 5 minutes](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), which again equals the inactive timeout. The same page says scheduled runs can be delayed under high load, and that some queued jobs may be dropped.
- In a private repository, with the default schedule, a run every 5 minutes for 9 hours is 108 runs a day. GitHub [rounds each job up to a whole minute](https://docs.github.com/en/billing/reference/actions-runner-pricing), so a month of 22 weekdays uses 2,376 minutes. [The free plan includes 2,000](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
- In a public repository, the minutes are free, but any GitHub user can read the run logs.
- The renewed refresh token has to go back into a repository secret after each renewal. The permissions of the workflow's own token do not include secrets, so you would store a personal access token with write access to secrets next to it.
- [GitHub's terms for Actions](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features) say that on GitHub-hosted runners, Actions should not be used for "any other activity unrelated to the production, testing, deployment, or publication of the software project associated with the repository where GitHub Actions are used". A Teams status is not a software project.

These places fail on one limit each:

- Oracle Cloud Always Free [may reclaim an idle VM](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm). Oracle counts a VM as idle when, over 7 days, its 95th percentile CPU use and its network use stay under 20%. A VM that only runs stay-green stays far under both.
- The AWS free plan [ends after six months or when the credits run out](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), whichever comes first, and the account then closes.
- An Android phone cannot schedule a periodic job more often than every 15 minutes, as `MIN_PERIOD_MILLIS` in [Android's `JobInfo` source](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/android-29/+/refs/heads/androidx-wear-release/android/app/job/JobInfo.java) shows. [Doze](https://developer.android.com/training/monitoring-device-state/doze-standby) also stops scheduled jobs and network access while the phone sleeps.
- Vercel's Hobby plan runs a cron job [once a day](https://vercel.com/docs/cron-jobs/usage-and-pricing).

I also looked at Azure Functions, Deno Deploy, Netlify, and cron-job.org. Azure Functions needs a [payment card](https://azure.microsoft.com/en-us/free/free-account-faq/) and a [storage account](https://learn.microsoft.com/en-us/azure/azure-functions/storage-considerations), and cron-job.org only calls a URL, so it still needs a host and a place for the refresh token. Deno Deploy and Netlify may work, but I did not test them, so this page does not rank them.
