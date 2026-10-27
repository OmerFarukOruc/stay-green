# Run stay-green on a Linux box

This guide sets up stay-green on a Linux computer that stays on in your working hours, such as a Raspberry Pi, a home server, or a [Google Cloud e2-micro VM](where-to-run-it-for-free.md#3-a-google-cloud-e2-micro-vm). A systemd timer starts it every 4 minutes, and each run checks your schedule.

You need:

- A Linux box with systemd, `git`, and Python 3.9 or newer. stay-green needs nothing beyond the Python standard library.
- A computer with a browser, Python 3.9 or newer, and `git`, to sign in. It can be the box itself. If it is another computer, it also needs `ssh` access to the box.
- A work or school Microsoft 365 account. Graph does not let an app set the presence of a personal Microsoft account.

Read [the risks](risks.md) before you start.

## Get the code on the box

Clone the repository to `~/stay-green` on the box. The systemd service expects that path.

```sh
git clone https://github.com/OmerFarukOruc/stay-green ~/stay-green
```

## Sign in

The sign-in opens a Microsoft page in a browser and receives the result on a `localhost` port, so it runs on the computer that has the browser.

If the box has a browser, run this on the box:

```sh
~/stay-green/stay-green login
```

If the box has no browser, clone the repository on your own computer too, and sign in there with the box's SSH host name. The script stores the refresh token on the box over SSH.

```sh
git clone https://github.com/OmerFarukOruc/stay-green
python3 stay-green/stay-green login my-box
```

Sign in with your work account. If Microsoft asks you to accept the permissions, accept them. The script then prints a line that starts with `Stored the sign-in`.

If you set `XDG_STATE_HOME` on the box, `login HOST` stores the refresh token under the value that an SSH command sees, and the timer uses the value that the systemd user manager sees. Compare the two with `ssh my-box 'echo $XDG_STATE_HOME'` and, on the box, `systemctl --user show-environment | grep XDG_STATE_HOME`.

## Check the sign-in

On the box, print your current status:

```sh
~/stay-green/stay-green status
```

The first line shows your availability and activity, such as `Away / Away`. The second line says whether now is inside the default schedule, `Mon-Fri 09:00-18:00` in the box's time zone. An error here means the sign-in did not work. [The reference](reference.md#errors) lists the errors.

## Install the timer

Copy the units to your systemd user folder:

```sh
mkdir -p ~/.config/systemd/user
cp ~/stay-green/systemd/stay-green.service ~/stay-green/systemd/stay-green.timer ~/.config/systemd/user/
```

If you cloned the repository somewhere other than `~/stay-green`, change `ExecStart` in `~/.config/systemd/user/stay-green.service` to match.

## Set your schedule

Edit the two `Environment=` lines in `~/.config/systemd/user/stay-green.service`:

```ini
Environment="STAY_GREEN_SCHEDULE=Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00"
Environment=STAY_GREEN_TIME_ZONE=America/New_York
```

`STAY_GREEN_SCHEDULE` lists days and time ranges. A range ends before its end time, so `13:30-18:00` has its last run at 17:56. [The reference](reference.md#schedule) defines the format. `STAY_GREEN_TIME_ZONE` is an IANA time zone name. Without that line, the schedule uses the box's time zone.

To check your schedule before you start the timer, run `status` with the same values:

```sh
STAY_GREEN_SCHEDULE='Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00' \
STAY_GREEN_TIME_ZONE=America/New_York ~/stay-green/stay-green status
```

A mistake in either value makes `status` fail with a message that names the wrong part.

## Start the timer

```sh
systemctl --user daemon-reload
systemctl --user enable --now stay-green.timer
```

A user timer runs only while your user has a session, unless lingering is on. On a box that you do not stay logged in to, turn lingering on before you log out:

```sh
sudo loginctl enable-linger "$USER"
```

## Check the first run

Inside your schedule, start one run now, then read its result:

```sh
systemctl --user start stay-green.service
journalctl --user -u stay-green.service -n 5
```

The journal shows a line such as `marked Available; the status was Away`. Outside your schedule, the run ends at once and logs no line of its own.

`systemctl --user list-timers stay-green.timer` shows when the next run starts.

## Run it in a container

If the box has rootless Podman, you can run each run in a throwaway container that sees only the script and the refresh token. In `~/.config/systemd/user/stay-green.service`, change `ExecStart` to the line in the comment above it:

```ini
ExecStart=%h/stay-green/systemd/stay-green-container run
```

Then run `systemctl --user daemon-reload`. The container uses the official `python:3.13-alpine` image, and it gets your schedule settings and the box's time zone from the host.

## Update or stop it

To update, pull the repository. The next run uses the new script. Your copies of the units in `~/.config/systemd/user/` stay as they are. If a release changes a file in `systemd/`, copy it again, apply your edits again, and run `systemctl --user daemon-reload`.

```sh
git -C ~/stay-green pull
```

To stop it and delete the refresh token from the box:

```sh
systemctl --user disable --now stay-green.timer
rm -r "${XDG_STATE_HOME:-$HOME/.local/state}/stay-green"
```

The deleted refresh token stays valid at Microsoft until it expires. To make every copy useless, ask your admin to revoke your refresh tokens, as [the risks](risks.md#a-stolen-refresh-token-acts-as-you) describe.
