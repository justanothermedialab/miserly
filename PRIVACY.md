# Privacy

Last updated 23 November 2026. This covers the Miserly app (the Windows app, from GitHub or the
Microsoft Store, and the Docker image).

## What Miserly keeps

Only what you enter:

- your accounts, transactions, categories, payees and settings
- your username, a hash of your password (never the password itself) and your signed-in sessions
- if you import from Actual Budget, what you choose to bring in from the file you pick

All of it is kept in one file, `miserly.db`, on your own computer or your own server:

- **The Windows app:** on your computer. **Settings**, **Your data** shows where.
- **Docker:** on the server you run it on, in its `/data` volume.

On Docker, the server's log also records failed sign-ins, lockouts, password resets and people
added or removed, with the username and the address each came from. It never records a password.

## What Miserly sends

Nothing.

- No account with us, no analytics, no tracking, no crash reports and no ads.
- No connection to your bank, your broker, your SMS or your email, and no reading of statements.
- The Windows app runs its own server on your computer (`127.0.0.1`) and works offline.
- With Docker, your browser talks only to your own server. Anyone who can reach that server's
  address can reach the sign-in page, so outside a home network you trust, put it behind HTTPS.
  The guide shows how.

Links in the app, such as the user guide or Report a problem, open in your browser. What
happens there is up to that website.

## Who can see it

- You, and the people you share an account with. Each account is private until its owner
  shares it.
- An admin adds and removes people and can reset a password. The member is told when that
  happens. An admin can't see anyone else's accounts.
- Nobody at JAM Lab can see anything you keep in Miserly.

## Removing it

Delete `miserly.db` (on Docker, the volume) and it is gone. There is nothing of yours anywhere
else to remove.

## Questions

Open an issue on [GitHub](https://github.com/justanothermedialab/miserly/issues).
