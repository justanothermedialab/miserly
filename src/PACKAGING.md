# Packaging and deployment

Miserly is one Node server (`node build/index.js`, built with `@sveltejs/adapter-node`) packaged
two ways: **Docker** (self-hosted: the data lives on the server and any device with a browser can
reach it, no sync engine) and **Electron** (desktop: fully offline, the local SQLite file is the
record). Both run the same server; only how it starts and where its data lives differ.

## The environment variables

| Var | Meaning | Default |
|---|---|---|
| `MISERLY_DB_PATH` | Path to the SQLite file. Its folder is created if missing; migrations run at start. | must be set |
| `PORT` | Port the server listens on. | `3000` |
| `HOST` | Interface the server binds to. | `0.0.0.0` |
| `ORIGIN` | The address the browser uses to reach this instance. **Required when hosted:** SvelteKit checks it against form posts (sign-in, first-run setup) as a CSRF defence; if it is missing or wrong, those posts fail with a 403 and no clearer error. | must be set (the desktop app sets it for its own server) |
| `MISERLY_SETUP_CODE` | `on`: a fresh instance prints a one-time setup code to its log and the setup page asks for it. `off`: whoever opens the setup page first creates the first login. | `on` in the Docker image, off in the desktop app |

The database path, `ORIGIN` and `PORT` are the ones that matter; `HOST` rarely needs changing.

## Docker (self-hosted)

```bash
docker build -f src/Dockerfile -t miserly src/
docker run -e ORIGIN=http://localhost:3000 -p 3000:3000 -v miserly-data:/data miserly
```

Or, from `src/`, with the compose file:

```bash
docker compose up
```

The image sets `MISERLY_DB_PATH=/data/miserly.db` and `PORT=3000` and exposes port 3000; `/data`
is a volume, so the database survives the container being recreated. `ORIGIN` is not built into
the image: give it at run time, and behind a reverse proxy it must be the outside address (not
`localhost`), or sign-in and setup fail with a 403.

On the first visit the app goes to `/setup` to create the admin login. The image sets
`MISERLY_SETUP_CODE=on`, so a fresh instance prints a one-time setup code to its log at start
(`docker compose logs miserly`, a line with "miserly setup code") and the setup page asks for it:
someone who reaches the port before you can't take the instance over. The desktop app doesn't ask
(its server listens on 127.0.0.1 only). With Podman the log is `podman logs <container>`; Cockpit
shows it in the container's Logs. Each start prints a new code until the first login exists, and
only the latest works.

On a network where every device is trusted, the code can be turned off with
`MISERLY_SETUP_CODE=off`; then the first person to open the setup page creates the login (as in
Actual Budget):

- `docker run` or `podman run`: add `-e MISERLY_SETUP_CODE=off`.
- An env file: a line `MISERLY_SETUP_CODE=off` in a file passed with `--env-file <file>`.
- Compose: `MISERLY_SETUP_CODE: "off"` under the service's `environment:`. Keep the quotes: YAML
  reads a bare `off` as false, which Compose refuses.
- A Podman Quadlet unit (`/etc/containers/systemd/miserly.container`):
  `Environment=MISERLY_SETUP_CODE=off` under `[Container]`.

All the data is in the `/data` volume. Back it up by copying the SQLite file out of the volume
(with the container stopped, or the `-wal` file beside it as well); the app has no backup download
yet.

## Electron (desktop)

From `src/`:

```bash
pnpm --filter @miserly/desktop start      # runs the server and a window onto it (127.0.0.1)
pnpm --filter @miserly/desktop portable   # the Windows build and its zip, in apps/desktop/dist/
```

`start` runs the server and a window pointed at it on `127.0.0.1`, fully offline; the database
lives in the operating system's app-data folder (managed by Electron) and the shell sets `ORIGIN`
itself.

Releases ship a portable zip, not an installer: `portable` runs `electron-builder --dir` and then
`scripts/portable-zip.mjs`, which writes `Miserly-preview-<version>-portable.zip`. The build is not
code signed, so Windows shows "Windows protected your PC" the first time (More info, then Run
anyway). `better-sqlite3` is a native addon and is rebuilt for Electron during the build;
`@node-rs/argon2` uses N-API and needs no rebuild. The server ships as `extraResources` (outside
the asar), so its native `.node` files load without an asar-unpack step.

> **Build the desktop app in CI or a separate checkout, not your everyday workspace.**
> `@electron/rebuild` rebuilds `better-sqlite3` where it lives, and pnpm links it from a shared
> store, so a `portable` or `prepare:server` run in your workspace switches that shared copy to
> Electron's ABI and breaks the web package's tests, dev server and Docker build (a
> `NODE_MODULE_VERSION` mismatch). A fresh store (CI, or a throwaway clone) isn't shared, so the
> rebuild stays contained. If you ran it by accident, restore it with
> `pnpm --filter better-sqlite3 exec prebuild-install -r node`. Running the app with `start` is
> fine anywhere; only the packaged build has this constraint.

## Not yet

- Code signing for the zip (a Microsoft Store copy, signed by Microsoft, is planned).
- Auto-update.
- Encryption at rest for the SQLite file.
- Sync between desktop copies.
