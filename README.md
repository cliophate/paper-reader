# Paper

A self-hosted FreshRSS reader with full-text articles, search, filters, keyboard
shortcuts, and offline reading. Works on desktop and mobile. FreshRSS keeps your
subscriptions, read state, and stars in sync.

Entirely AI-coded. If this steals kittens, don't blame me.

Paper is an early single-user alpha with no built-in login. Keep it local or
use an [authenticated HTTPS proxy](docs/access.md) for remote access.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/desktop-dark.png">
  <img src="docs/screenshots/desktop-light.png" alt="Paper on desktop, with Linux feeds and a Linuxiac article open">
</picture>

<details>
<summary>Mobile view</summary>

<img src="docs/screenshots/mobile-light.png" alt="Reading a Linuxiac article in Paper on mobile" width="360">

</details>

## Quick start

You need Docker Compose 2.24.4 or newer and a working FreshRSS installation.
The published image supports Linux amd64.

1. Enable the Google Reader API in FreshRSS and set an API password for your
   user. Paper uses this separate password to connect.
2. Clone Paper and create its configuration:

   ```sh
   git clone https://github.com/cliophate/paper-reader.git
   cd paper-reader
   sh scripts/setup.sh
   ```

3. Edit `.env` and fill in `FRESHRSS_BASE_URL`, `FRESHRSS_USERNAME`, and
   `FRESHRSS_API_PASSWORD`. Use your FreshRSS root URL, such as
   `https://rss.example.com`. Set `PUBLIC_URL` to the address you will use to
   open Paper, which defaults to `http://localhost:8080`.
4. Start Paper:

   ```sh
   docker compose config --quiet
   sh scripts/pull-image.sh
   docker compose up -d --no-build paper
   ```

Open [localhost:8080](http://localhost:8080). Paper imports your FreshRSS archive
in the background. Search becomes available when the initial import finishes.

FreshRSS must be reachable from Paper's container. If both run on the same
Docker host, use a shared network or a reachable host address. `localhost`
inside the container refers to Paper itself.

To use a different local port, change `PAPER_PORT` and `PUBLIC_URL` in `.env`.
For access from other devices, follow the [remote access guide](docs/access.md).

## Optional connections

Open **Settings > Reading & connections** to enable:

- AI discussions, headline cleanup, Pulse story grouping, and briefings.
- Readwise Reader saves.
- Kirby note drafts through a compatible publishing plugin.

Each connection has setup instructions. Readwise and Kirby tokens can be saved
in Settings. AI requires the optional AI image and a CLI login. Reading works
without any of these connections.

See the [integration guide](docs/integrations.md) for full setup instructions.

## Your data

Back up `./data` and your private `.env`. The data directory holds reading
positions, discussions, filters, saved briefings, and any connection tokens
entered in Settings. FreshRSS needs its own backup too.

See [backup, restore, and upgrades](docs/recovery.md) before updating Paper,
and [security and privacy](SECURITY.md) for details about stored data and
external services.

## Build from source

After setup and configuration:

```sh
docker compose build paper
docker compose up -d --no-build paper
```

For local development and tests, see the [development guide](docs/development.md).

## License

[MIT](LICENSE). Third-party components retain their own licenses, listed in
[third-party notices](THIRD_PARTY_NOTICES.md).
