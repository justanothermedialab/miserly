---
title: Install
sidebar:
  order: 3
---

Miserly comes two ways: a Windows app, from the Microsoft Store or as a portable zip, and a
Docker image for a home server that you open in a desktop browser, such as Edge, Chrome or
Firefox. Phones aren't supported yet.

## Windows

Miserly runs on Windows 10 and 11, from the Microsoft Store or as a portable zip. Both are the
same app. The Store installs it and keeps it up to date; the zip runs from its own folder with no
install.

### From the Microsoft Store

1. Open [Miserly on the Microsoft Store](https://apps.microsoft.com/detail/9NV8FTQ2SBX3) and
   click **Get**. If the Store app opens, click **Get** or **Install** there.
2. Open **Miserly** from the Start menu.

Updates come through the Store by themselves. Your data is kept in a folder called **Miserly
data** in your user folder, such as `C:\Users\Asha\Miserly data`. To remove Miserly, open
Windows **Settings**, **Apps**, **Installed apps**, then Miserly's **⋯** and **Uninstall**. The
**Miserly data** folder stays; delete it yourself if you want your data gone.

### The portable zip

1. Download **Miserly-preview-26.11.0-portable.zip** from
   [Releases](https://github.com/justanothermedialab/miserly/releases).
2. Right-click **Miserly-preview-26.11.0-portable.zip** and choose **Extract All**, then
   **Extract**. Pick a place you'll keep, such as Documents. Don't run Miserly from inside the
   zip without extracting it: it won't start.
3. Open the extracted **Miserly** folder and double-click **Miserly.exe**.
4. Windows may show **Windows protected your PC**. This preview isn't signed with a publisher
   certificate, so Windows doesn't recognise it. Click **More info**, then **Run anyway**.
   Windows only asks the first time.

To open it from the taskbar later, right-click Miserly's taskbar button while it's open and
choose **Pin to taskbar**.

The zip also holds **Miserly guide.html**, this guide as one file that opens without the
internet.

#### Your data lives in the folder

Everything Miserly keeps is in the **data** folder next to **Miserly.exe**. Keep the two
together. Moving or copying the whole **Miserly** folder takes your data with it. Deleting the
folder deletes your data. See [Your data](your-data.md) for backups.

#### Updating to a newer version

1. Close Miserly.
2. Extract the new zip somewhere new.
3. Copy the **data** folder from your old **Miserly** folder into the new one, replacing the
   one there.
4. Open the new **Miserly.exe**. When you're happy, delete the old folder.

If a new version needs to change how your data is stored, it copies the file first, and if the
change fails it puts the copy back and stops. Keep your own backups anyway.

#### Removing it

Close Miserly and delete the **Miserly** folder. That removes the app and your data, so copy
the **data** folder somewhere first if you might want it back.

## Docker

Docker runs Miserly on a home server, and you open it in a desktop browser such as Edge, Chrome
or Firefox. There are two ways. Both use the published image,
`ghcr.io/justanothermedialab/miserly`.

### Quick start: one command

1. Start Miserly:

   ```sh
   docker run -d --name miserly -p 3000:3000 -v miserly-data:/data      -e ORIGIN=http://localhost:3000 ghcr.io/justanothermedialab/miserly
   ```

2. Read the setup code with `docker logs miserly` (see [The setup code](install.md#the-setup-code)).
3. Open `http://localhost:3000` and create your login, as in the
   [Quick start](quick-start.md#2-create-your-login).

### Keep it running: Docker Compose

1. Download the compose file into a new folder:

   ```sh
   mkdir miserly && cd miserly
   curl -O https://raw.githubusercontent.com/justanothermedialab/miserly/main/src/docker-compose.yml
   ```

2. Start Miserly:

   ```sh
   docker compose up -d
   ```

   It starts again by itself after the machine restarts. `docker compose ps` shows it as
   **healthy** once it answers.

3. Read the setup code with `docker compose logs miserly`, then open `http://localhost:3000`.

The compose file opens Miserly on port 3000 of that machine only. To reach it from other
devices, see [Running it on your network](install.md#running-it-on-your-network).

### ORIGIN must match the address you open

`ORIGIN` is the address your browser uses to open Miserly. It's `http://localhost:3000` unless
you set it.

- If it doesn't match, signing in shows a plain page that says "Cross-site POST form submissions
  are forbidden".
- `localhost` and `127.0.0.1` count as different addresses. Open Miserly at exactly the one in
  `ORIGIN`.

### The setup code

A new Docker install prints a setup code to its log when it starts. It stops anyone who reaches
the page before you from creating the first login.

1. Read the log: `docker logs miserly`, or `docker compose logs miserly` with Compose. With
   Podman, use `podman logs` and the container's name, or open the container in Cockpit.
2. Find the line that starts "miserly setup code:".
3. Type the code in **Setup code** on the first page.

Each start prints a new code, so after a restart use the latest one.

### Where your data is kept

In a Docker volume named `miserly-data`. The file inside it is `/data/miserly.db`.

To keep the data in a folder you can see instead, use `./data:/data` in place of
`miserly-data:/data` (in the `docker run` command, or the volume line of the compose file).
Miserly runs as user 1000 inside the container, so on Linux the folder must belong to user 1000:

```sh
mkdir data
sudo chown 1000:1000 data
```

- If you skip this, Miserly stops as soon as it starts, and the log says "unable to open
  database file".
- Or run Miserly as the folder's owner: add `user: "1001:1001"` under `miserly` in the compose
  file, with the numbers `ls -n` shows for the folder.
- With rootless Podman, add `:U` to the folder line (`./data:/data:U`) and Podman sets the owner
  itself.
- Docker Desktop on Windows needs none of this.

### Where it runs

| Setup | Status |
|---|---|
| Docker Desktop on Windows (WSL 2) | Tested, with a volume and with a Windows folder |
| Podman 4.9 on RHEL 8.10 (SELinux on) | Tested as root and rootless, including updating to a new image and going back |
| Docker on Linux | Same image, not yet tested |
| ARM64 (Apple silicon, Raspberry Pi 4 and 5, ARM NAS boxes) | The image is built for it, not yet tested |
| Docker Desktop on a Mac | Not yet tested |

With Podman, the `docker run` command works the same with `podman` in its place.

### Running it on your network

How you reach Miserly from your other devices decides who else could read what you type.

**The safe way: a proxy with HTTPS.** Give Miserly a host name of its own, such as
`miserly.home.example`. The compose file has this ready:

1. Uncomment the `caddy` service in `docker-compose.yml`.
2. Download [`Caddyfile.example`](https://raw.githubusercontent.com/justanothermedialab/miserly/main/src/Caddyfile.example),
   save it as `Caddyfile` next to the compose file, and put your host name in it.
3. Start Miserly with that address:

   ```sh
   ORIGIN=https://miserly.home.example docker compose up -d
   ```

With this, your password and session travel encrypted, Miserly's own port stays closed to the
network, and your sign-in is never sent to other apps on the same machine.

- If the name is a domain you own that the internet can reach, Caddy gets a certificate by
  itself.
- If the name is known only on your home network, use `tls internal` (shown in the example) and
  trust Caddy's certificate once on each device. Caddy's documentation walks through it.
- Tailscale's HTTPS names are another way to get the same result.

**Plain HTTP: only on a home network where you trust every device.** Change the port line in
`docker-compose.yml` to `"3000:3000"` and set `ORIGIN=http://<machine name>:3000`. It works,
but your password and session cross the network unencrypted, so anyone who can see that traffic
could sign in as you.
