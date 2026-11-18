# cf-ip-updater

A tiny Cloudflare Worker that lets a router keep Cloudflare DNS records pointed at its WAN IPs. Built for the TP-Link ER605 / Omada "Custom DDNS" option, but it works with any client that can call a URL (it also speaks the DynDNS2 `/nic/update` protocol used by ddclient and inadyn).

- **Narrow access.** Each router login can only update the hostnames you list for it. The Cloudflare API token stays inside the Worker and never touches the router.
- **Cheap.** One request per heartbeat, about 1–2 ms of CPU. The DNS record is only written when the IP actually changes.
- **Dual-WAN friendly.** Give each WAN its own login and hostname.
- **IPv4 and IPv6.** Updates the `A` or `AAAA` record depending on the IP it receives.

## How it works

```
Router (every N minutes)
  └─ GET https://<user>:<pass>@ddns.example.com/v1/ddns/heartbeat?domain=wan1.example.com&ip=203.0.113.10
       └─ Worker: check login → check hostname is allowed for that login
            └─ Cloudflare API: read record → update only if the IP changed
```

Cloudflare API tokens can be limited to a zone, but not to individual records. So the token gets `DNS:Edit` on one zone, and the Worker enforces the per-hostname allowlist.

## Setup

### 1. Create a Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**:

| Setting | Value |
| --- | --- |
| Permissions | Zone → DNS → Edit |
| Zone Resources | Include → Specific zone → *your zone* |

Copy the token, and your zone ID from the zone's **Overview** page.

### 2. Describe your router logins

Copy `ddns-clients.example.json` to `ddns-clients.json` (gitignored) and fill it in. Each key is a router "Account Name":

```json
{
  "wan1-router": {
    "password": "<48 hex chars>",
    "zone_id": "<32-char zone id>",
    "hostnames": ["wan1.example.com"]
  }
}
```

Generate passwords with only URL-safe characters, since the router puts them inside the update URL:

```sh
openssl rand -hex 24
```

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLower()
```

### 3. Deploy

```sh
npm install
npx wrangler login
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put DDNS_CLIENTS < ddns-clients.json
```

PowerShell does not support `<` redirection; use:

```powershell
Get-Content ddns-clients.json -Raw | npx wrangler secret put DDNS_CLIENTS
```

To serve it from your own domain without committing that domain, copy `wrangler.jsonc` to `wrangler.local.jsonc` (gitignored), add a route, and turn off the `workers.dev` URL:

```jsonc
  "workers_dev": false,
  "routes": [{ "pattern": "api.example.com/v1/ddns/*", "zone_name": "example.com" }],
```

Then deploy with `npm run deploy:local`. The hostname in the route needs a proxied (orange-cloud) DNS record. If another Worker already serves that hostname, the more specific `/v1/ddns/*` route takes precedence for those paths.

`npm run deploy` uses the generic `wrangler.jsonc` and publishes to `cf-ip-updater.<your-subdomain>.workers.dev`.

### 4. Configure the router

In the router's Dynamic DNS settings, add a custom DDNS entry for each WAN:

| Field | Value |
| --- | --- |
| Interface | WAN1 (and a second entry for WAN2) |
| Account Name | the key from `ddns-clients.json`, e.g. `wan1-router` |
| Password | that client's password |
| Domain Name | the hostname, e.g. `wan1.example.com` |
| Update / Server URL | `https://[USERNAME]:[PASSWORD]@api.example.com/v1/ddns/heartbeat?domain=[DOMAIN]&ip=[IP]` |
| Update Interval | 5 minutes is plenty; 1 also works |

The URL must use `https://`; the Worker refuses plain HTTP so passwords are never sent in cleartext.

## Request reference

`GET` or `POST` to `/v1/ddns/heartbeat` (or `/nic/update`), with parameters in the query string.

| Parameter | Aliases | Notes |
| --- | --- | --- |
| `domain` | `hostname` | Must be in the client's `hostnames` list. |
| `ip` | `myip` | Optional. If missing or private (e.g. the WAN is behind a modem doing NAT), the request's source IP is used instead, as long as it's the same IP version. |
| `username` / `password` | `user` / `pass` | Only if the client can't send HTTP Basic auth. The password then appears in the request URL, which Workers Logs can record. |

Responses are plain text in DynDNS2 style:

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `good <ip>` | Record created or updated |
| 200 | `nochg <ip>` | Record already had this IP |
| 400 | `notfqdn` / `badip` | Missing hostname, or no usable public IP |
| 401 | `badauth` | Wrong or missing login |
| 403 | `nohost` | Hostname not allowed for this login |
| 403 | `httpsrequired` | Request was not HTTPS |
| 409 | `dnserr` | More than one matching record; fix it in the dashboard |
| 502 / 500 | `911` | Cloudflare API error or bad `DDNS_CLIENTS` config (see Worker logs) |

New records are created with TTL 60 and proxying off. Existing records keep their TTL and proxy setting; only the IP is changed.

## Cost

Two WANs every minute is about 2,900 requests/day, roughly 3% of the Workers Free plan's 100,000/day. Each request uses about 1–2 ms of CPU against the 10 ms limit; time spent waiting on the Cloudflare API doesn't count as CPU time.

## Development

```sh
cp .dev.vars.example .dev.vars   # local-only secrets
npm run dev
npm test
npm run typecheck
```

Run `npm run types` after changing `wrangler.jsonc`.

## License

[MIT](LICENSE)
