# Run stay-green on a Linux box

Run stay-green on a Linux machine that stays on during your working hours, such as a Raspberry Pi, a home server, or a [Google Cloud e2-micro VM](where-to-run-it-for-free.md#3-a-google-cloud-e2-micro-vm). A systemd user timer starts the script every 4 minutes, and each run checks your schedule.

You need:

- A Linux box with systemd, `git`, and Python 3.9 or newer. The script uses the Python standard library with no third-party packages.
- A computer with a browser, `git`, and Python 3.9 or newer for the initial sign-in. You can sign in on the box itself or from another computer that has `ssh` access to the box.
- A work or school Microsoft 365 account. Microsoft Graph does not allow an app to set the presence of a personal Microsoft account.

Read [the risks](risks.md) before you start.

## Get the code on the box

Clone the repository to `~/stay-green` on the box, where the systemd service expects it:

```sh
git clone https://github.com/OmerFarukOruc/stay-green ~/stay-green
```

## Sign in

Sign-in opens a Microsoft page in a browser and catches the redirect on a local `localhost` port, so run it on the machine with the browser.

If the box has a browser, sign in on the box:

```sh
~/stay-green/stay-green login
```

If the box is headless, clone the repository on your own computer and pass the box's SSH host name to `login` so the script copies the refresh token over SSH:

```sh
git clone https://github.com/OmerFarukOruc/stay-green
python3 stay-green/stay-green login my-box
```

Sign in with your work account and accept the permission prompt if Microsoft shows one. On success, the script prints a line starting with `Stored the sign-in`.

If you set `XDG_STATE_HOME` on the box, `login HOST` writes the refresh token using the environment of a non-interactive SSH command, whereas the timer uses the environment of the systemd user manager. Verify that both match by comparing `ssh my-box 'echo $XDG_STATE_HOME'` with `systemctl --user show-environment | grep XDG_STATE_HOME` on the box.

## Check the sign-in

On the box, query your current presence:

```sh
~/stay-green/stay-green status
```

The first line prints your availability and activity, such as `Away / Away`, and the second line states whether the current time falls inside the default schedule (`Mon-Fri 09:00-18:00` in the box's time zone). If `status` prints an error, look it up in [the error reference](reference.md#errors).

## Install the timer

Copy the service and timer units into your systemd user directory:

```sh
mkdir -p ~/.config/systemd/user
cp ~/stay-green/systemd/stay-green.service ~/stay-green/systemd/stay-green.timer ~/.config/systemd/user/
```

If you cloned the repository to a path other than `~/stay-green`, update `ExecStart` in `~/.config/systemd/user/stay-green.service` to match.

## Set your schedule

Edit the two `Environment=` lines in `~/.config/systemd/user/stay-green.service`:

```ini
Environment="STAY_GREEN_SCHEDULE=Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00"
Environment=STAY_GREEN_TIME_ZONE=America/New_York
```

`STAY_GREEN_SCHEDULE` defines your working days and time ranges using the syntax in [the schedule reference](reference.md#schedule). A range ends before its end time, so `13:30-18:00` fires its last run at 17:56. `STAY_GREEN_TIME_ZONE` takes an IANA time zone name, or falls back to the box's system time zone if you remove the line.

Before starting the timer, test both settings with `status`:

```sh
STAY_GREEN_SCHEDULE='Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00' \
STAY_GREEN_TIME_ZONE=America/New_York ~/stay-green/stay-green status
```

An invalid schedule or time zone makes `status` exit with an error naming the bad part.

## Start the timer

Reload the user manager and enable the timer:

```sh
systemctl --user daemon-reload
systemctl --user enable --now stay-green.timer
```

By default, systemd stops user timers when your last session logs out. On a box where you do not stay logged in, enable lingering for your user before disconnecting:

```sh
sudo loginctl enable-linger "$USER"
```

## Check the first run

During scheduled hours, trigger a single run and inspect its journal output:

```sh
systemctl --user start stay-green.service
journalctl --user -u stay-green.service -n 5
```

Inside your schedule, the journal records a line such as `marked Available; the status was Away`. Outside your schedule, the service exits right away without logging a stay-green line.

To see when the next run fires, run `systemctl --user list-timers stay-green.timer`.

## Run it in a container

If the box has rootless Podman installed, you can isolate each run in a throwaway container that mounts the script and the refresh token and nothing else. In `~/.config/systemd/user/stay-green.service`, replace `ExecStart` with the commented container command above it:

```ini
ExecStart=%h/stay-green/systemd/stay-green-container run
```

Reload the unit configuration with `systemctl --user daemon-reload`. The wrapper runs the official `python:3.13-alpine` image and passes through your schedule settings and the host's time zone.

## Update or stop it

To update stay-green, pull the latest commits on the box:

```sh
git -C ~/stay-green pull
```

The next timer run uses the updated script while leaving your unit files in `~/.config/systemd/user/` untouched. If a release updates a file in `systemd/`, copy the changed unit to `~/.config/systemd/user/`, re-apply your schedule edits, and run `systemctl --user daemon-reload`.

To stop the timer and remove the stored tokens from the box:

```sh
systemctl --user disable --now stay-green.timer
rm -r "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green"
```

Deleting the local state directory does not invalidate the refresh token at Microsoft before its expiration date. To invalidate every copy at once, ask your admin to revoke your refresh tokens, as [the risks](risks.md#a-stolen-refresh-token-acts-as-you) describe.
