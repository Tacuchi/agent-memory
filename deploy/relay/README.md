# Deploy the relay in one step

You only need a relay when your two machines cannot reach each other directly: for example, a work laptop that is not
on your Tailscale tailnet or your home network. If they can, use the direct connection instead (see the main
[README](../../docs/remote-link.md#choose-how-to-connect)).

The relay is a published image, `ghcr.io/tacuchi/agent-memory-relay`. The platform runs it, gives it HTTPS and keeps
the key as a secret. You do not build anything, set up a reverse proxy, get certificates or add rate limiting: the
relay limits failed key attempts by itself.

## What every deployment needs

- **The key.** Generate it once on your machine, into a file only you can read. You enter the same key on both PCs
  later, so keep the file (or move it to your password manager).

  ```sh
  openssl rand -base64 32 > relay.key && chmod 600 relay.key
  ```

  On the platform it goes only in the secret `AGENT_MEMORY_RELAY_KEY`. Never commit it, bake it into an image or pass
  it to the relay as an argument.

- **The client IP header.** The relay counts failed key attempts per client IP. Behind a platform proxy, that IP comes
  from a header the proxy sets. Set `AGENT_MEMORY_RELAY_IP_HEADER` to the one your platform uses (the sections below
  say which). The default is `cf-connecting-ip`, the header Cloudflare sets. `ninguna` uses the TCP connection's
  address.

- **Long-lived connections.** Both PCs keep a WebSocket open to the relay. Plans that stop or sleep the service drop
  those connections.

## Fly.io

Checked against Fly's documentation on 2026-11-17: Fly Proxy terminates HTTPS and sets `Fly-Client-IP` to the
client's address.

1. Copy [`fly.toml`](fly.toml) and change `app` to a name of your own.
2. Create the app, store the key and deploy:

   ```sh
   fly apps create <your-app>
   fly secrets set AGENT_MEMORY_RELAY_KEY="$(cat relay.key)" --stage -a <your-app>
   fly deploy -c fly.toml -a <your-app>
   ```

3. The relay URL is `wss://<your-app>.fly.dev`.

`fly.toml` keeps one machine always running (`auto_stop_machines = "off"`), because a stopped machine drops the PCs'
connections.

## Render

Checked against Render's documentation on 2026-11-17: Render terminates HTTPS, supports WebSockets and routes to the
port in `PORT`. A free web service sleeps after 15 minutes without inbound traffic (HTTP requests or WebSocket
messages) and takes a while to wake up. The PCs reconnect about once a minute, which normally keeps it awake, but a
paid instance is the reliable choice.

1. In the dashboard: **New → Web Service → Existing Image**, image `ghcr.io/tacuchi/agent-memory-relay:latest`.
2. Environment variables:
   - `AGENT_MEMORY_RELAY_KEY`: the contents of `relay.key`, as a secret.
   - `PORT`: `8787`.
   - `AGENT_MEMORY_RELAY_IP_HEADER`: leave it unset. Render's own documentation does not say which client IP header it
     sets; users report that its edge sets `CF-Connecting-IP`, the relay's default. Run the check below.
3. Do not set a health check path: the relay answers `401` to anything without the key.
4. The relay URL is `wss://<your-service>.onrender.com`.

## Coolify

1. **New resource → Docker Image**, image `ghcr.io/tacuchi/agent-memory-relay:latest`, exposed port `8787`.
2. Give it your domain with `https://`. Coolify's Traefik gets the certificate.
3. Environment variables:
   - `AGENT_MEMORY_RELAY_KEY`: the contents of `relay.key`, marked as secret.
   - `AGENT_MEMORY_RELAY_IP_HEADER`: `x-real-ip` when the domain points straight at the server. Traefik sets
     `X-Real-Ip` from the TCP connection, as long as you have not told it to trust forwarded headers from everyone
     (`forwardedHeaders.trustedIPs` with `0.0.0.0/0`).
4. Behind Cloudflare (proxied DNS record), keep the default `cf-connecting-ip` and let only Cloudflare's ranges in, or
   anyone who finds the server's IP can send a fake header. [`traefik-dynamic.yml`](traefik-dynamic.yml) does that.

The healthcheck in the image accepts the `401`: it never needs the key.

## Check it

Replace `<relay>` with your host.

1. Without the key the relay answers `401`, and with it `204`:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://<relay>/
   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat relay.key)" https://<relay>/
   ```

2. A client cannot dodge the attempt limit by changing headers. Send eleven wrong keys, each with a different fake IP
   in every header the platforms use:

   ```sh
   for i in $(seq 1 11); do
     curl -s -o /dev/null -w '%{http_code} ' -H 'Authorization: Bearer wrong-key-for-the-check-0000000000' \
       -H "Fly-Client-IP: 203.0.113.$i" -H "CF-Connecting-IP: 203.0.113.$i" -H "X-Real-Ip: 203.0.113.$i" \
       https://<relay>/
   done; echo
   ```

   Ten `401` and then `429` means the limit counts your real address. Eleven `401` means the platform passes a header
   the client can fake: set `AGENT_MEMORY_RELAY_IP_HEADER` to the one it does set, and check again.

   After this check your own IP waits 15 minutes before the relay accepts it again, even with the right key. Machines
   behind the same connection wait too.

## Then

Enter the relay URL and the key on both PCs: `agent-memory open` → **Remote access** (*Acceso remoto*) → **This PC**,
or `agent-memory remote relay wss://<relay> < relay.key`. Then pair them with a code, as the main README explains.
