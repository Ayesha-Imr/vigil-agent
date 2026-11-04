# Deploying vigil

vigil needs a machine that stays on. It doesn't need a GPU, or much CPU or memory: the models run
at your providers. Workers run real commands, though, so give vigil a machine (or a user, or a
container) you are comfortable letting an agent use.

| Where | Cost | Notes |
| --- | --- | --- |
| A small VPS (Hetzner CX22, DigitalOcean, Vultr) | ~$4–6/month | Simplest. 2 GB RAM is plenty |
| Oracle Cloud free tier (Ampere A1) | free | Generous, but sign-up can be fiddly |
| A Raspberry Pi 5 or an old laptop at home | power | Needs the home network to stay up |
| Your desktop | free | Fine to try; vigil sleeps when the machine does |

## 1. Prepare the machine

```bash
sudo adduser --disabled-password vigil && sudo -iu vigil
```

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 22
```

Optional, for workers and for `vigil verify`:

```bash
sudo apt-get install -y git ripgrep openjdk-17-jre-headless
```

## 2. Install vigil

```bash
git clone https://github.com/Ayesha-Imr/vigil-agent && cd vigil-agent && npm ci --ignore-scripts && npm run build && npm link
```

## 3. Configure

```bash
vigil init
```

You will need:

- **Telegram**: a bot token from @BotFather and your numeric user id from @userinfobot.
- Optionally **Discord**: a bot token (Message Content intent on) and your user id.
- Optionally **ntfy**: a topic name nobody will guess.

## 4. Log in to the models

ChatGPT Plus/Pro (Codex), via a device code you can complete on your phone:

```bash
vigil login codex
```

OpenCode Go, with an API key from <https://opencode.ai>:

```bash
vigil login opencode
```

You can also do either later from Telegram: `/login codex`, or `/login opencode <key>` (delete
that message afterwards). Check with:

```bash
vigil doctor && vigil models
```

## 5. Run it always

```bash
vigil service --write && systemctl --user daemon-reload && systemctl --user enable --now vigil
```

```bash
sudo loginctl enable-linger vigil
```

Logs: `journalctl --user -u vigil -f`. Restart after config changes:
`systemctl --user restart vigil`.

## 6. Reach the panel and HTTP API privately

The panel listens on `127.0.0.1:7777`. Don't open that port to the internet. Two good options:

- **Tailscale** (recommended): install it on the server and your phone, then
  `sudo tailscale serve --bg 7777`. The panel is at `https://<machine>.<tailnet>.ts.net/panel`,
  reachable only from your devices. Set `channels.http.publicUrl` to that URL to get ntfy action
  buttons.
- **SSH tunnel** from a laptop: `ssh -L 7777:127.0.0.1:7777 vigil@server`, then open
  `http://127.0.0.1:7777/panel`.

The panel asks for the HTTP token from `config.json` once, and remembers it in that browser.

## 7. Phone extras

- **iOS Shortcuts**: a "Get contents of URL" action, POST to `<publicUrl>/api/message`, header
  `Authorization: Bearer <token>`, JSON body `{"text": "<dictated text>"}`. Show the `reply` key
  of the result. That gives you "Hey Siri, ask vigil…".
- **A dead-man switch**: make a free check at <https://healthchecks.io> and put its ping URL in
  `healthcheckUrl`. If vigil stops pinging, healthchecks emails or pushes you.

## 8. Back up

Everything that matters is in `~/.vigil`: the database, memory, sessions and credentials. Back it
up (and keep the backup private: it holds your tokens). The memory directory is also a git repo,
committed nightly.

## Docker instead

```bash
npm ci --ignore-scripts && npm run build && docker compose build
```

```bash
docker compose run --rm vigil init && docker compose run --rm vigil login codex && docker compose up -d
```

Inside the container, workers can only touch what the container can: that is safer, and also less
useful for tasks on the host. Mount project directories you want vigil to work on as volumes.

## WhatsApp

Only with a spare number. Enable it in `vigil init`, run `vigil start` once in a terminal, and scan
the QR code with WhatsApp on that phone (Settings → Linked devices). Linking breaks if the phone is
offline for about two weeks. Baileys is unofficial; read its README before relying on it.
