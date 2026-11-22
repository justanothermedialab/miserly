---
title: Your data
sidebar:
  order: 13
---

Everything you type is kept in one file, `miserly.db`. Nothing in it is sent anywhere.

## On Windows

Where the file is depends on which copy you use:

- **Miserly from the Microsoft Store:** in a folder called **Miserly data** in your user folder,
  for example `C:\Users\Asha\Miserly data\miserly.db`. Uninstalling leaves this folder alone;
  delete it yourself if you want your data gone.
- **The portable zip:** in the **data** folder next to **Miserly.exe**, for example
  `Miserly\data\miserly.db`.

**Settings**, **Your data** shows the full path, with **Copy path** and **Open folder**. The
folder also holds the window's size and place and other small files Miserly needs; leave them
be.

### Backing up

1. Close Miserly fully (close the window; check it's gone from the taskbar).
2. Copy `miserly.db` somewhere safe: another drive, a USB stick or a cloud folder.

Do this every week or two while Miserly is a preview. If you ever need to restore, close
Miserly and copy your backup back over `miserly.db`.

### Moving to another computer

Close Miserly and copy `miserly.db` to the same place on the new computer (for the zip, you can
copy the whole **Miserly** folder). Open Miserly there and sign in with your usual username and
password.

### Moving between the zip and the Store copy

1. Close Miserly fully, in both copies.
2. Copy `miserly.db` from the old copy's folder into the new copy's folder, replacing the file
   there if there is one. Copy only `miserly.db`.
3. Open the new copy and sign in with your usual username and password.

## On Docker

The file is `/data/miserly.db` in the `miserly-data` volume. To back it up, stop Miserly so the
file is complete, copy the file out, and start it again, for example from the `src` folder:

```sh
docker compose stop
docker cp "$(docker compose ps -aq miserly)":/data/miserly.db ./miserly-backup.db
docker compose start
```

## Getting your data out

**Export** on any account's page or on **All transactions** saves those transactions as a CSV
file. The `miserly.db` file itself is a SQLite database, which any SQLite tool can open.
