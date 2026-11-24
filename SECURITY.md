# Security policy

## What to know before you run it

compareprice is meant to run on your own computer or home server.

- **The web page and API have no login.** `POST /api/compare` makes the service browse sites on your behalf, and `/settings` can change your configuration. Anyone who can reach the port can use both.
- **It listens on `127.0.0.1` by default**, and the Docker compose file publishes it on `127.0.0.1:7777` only.
- **Opening it to your home network** (so a phone can use it) means everyone on that network can use it. Do that only on a network you trust, and never forward the port to the internet or run it on public Wi-Fi.
- **Sessions stay on your machine.** Guest sessions and any site sign-ins live in the browser profile under the data folder. Nothing is stored in the source code, and the sign-in record keeps only a masked phone hint, never the number or an OTP.
- **In Docker, Chrome runs with `--no-sandbox`**, because Docker blocks the namespaces its sandbox needs. The container runs as an unprivileged user with no added capabilities, and that is the isolation boundary.

If you want it reachable from outside your home, put it behind your own authenticating reverse proxy or VPN. The project doesn't provide one.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Use GitHub's private reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**. If that isn't available, open an issue that says only that you have a security report, and leave the details out. A maintainer will reply with a way to share them.

Useful details: what you found, how to reproduce it, the commit or version, and how you ran the service (Docker or native, which host and port).

This is a small project maintained in spare time, so replies can take a few days. Reports about the unauthenticated design in the previous section are expected behaviour and are not vulnerabilities, but ideas for making it safer are welcome as feature requests.

## Supported versions

Only the latest release and `main` get fixes.
