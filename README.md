# Nflix for Nuvio

[nflixtv.cc](https://nflixtv.cc/) streams for [Nuvio](https://nuvio.wiki),
resolved **on your device**. This is a Nuvio *plugin* (provider), not a
Stremio-protocol addon: there is no server to host and no API to keep alive.

It calls the public Stremio endpoint that nflixtv.cc already publishes and maps
its stream objects into Nuvio's format.

## Install

> Plugins only work in sideloaded/debug Nuvio builds, not app-store builds.

1. Push this repository to GitHub (or serve it locally, see below).
2. In Nuvio: **Settings → Content & Discovery → Plugins → Add Repository**.
3. Paste the manifest URL:
   ```
   https://raw.githubusercontent.com/maba72/nuvio-nflixtv/master/manifest.json
   ```
4. Refresh, then enable **Nflix**.
5. Make sure a TMDB API key is set in Nuvio — meta ids and artwork come from
   TMDB, and providers are not usable without it.

For browsing/catalogs, also add the site's own Stremio addon if you want its
Nflix Movies / Nflix Shows rows with search:

```
https://nflixtv.cc/stremio/manifest.json
```

The plugin itself only supplies streams, the same way the other on-device
providers do. Keep Stremio Proxy streams **off** for these sources.

## Local development

```sh
npm run serve     # python3 -m http.server 8790 --bind 0.0.0.0
```

Then in a debug Nuvio build: **Settings → Developer → Plugin Tester** and load
`http://<your-lan-ip>:8790/manifest.json`. To test the provider alone, load
`http://<your-lan-ip>:8790/providers/nflixtv.js`.

Tests:

```sh
npm test             # fixture parsing + live nflixtv.cc smoke tests
npm run test:offline # fixtures only, no network
```

The fixtures under `test/fixtures/` are recorded `/stremio/stream` responses
for a movie and a series, so the parsers and on-device fetch contract are
covered without network access.

## How it works

```
GET https://nflixtv.cc/stremio/stream/{movie|series}/<id>.json
```

Ids are normalized to what Stremio expects: a bare `550` becomes `tmdb:550`,
`tt0111161` is passed through, and series get `:season:episode` appended
(`tmdb:1399:1:1`). The response is a list of direct, time-signed URLs:

- **MP4** — `https://bcdnt.<host>/resource/<id>.mp4?sign=...&t=...`
- **HLS** — `https://nflixtv.cc/stremio/media/.../4.2.m3u8`, whose segments are
  plain CDN `.ts` URLs

Neither form needs headers, cookies or a lease token — the upstream addon has
already done the minting. The provider copies quality, `bingeGroup`, video size
and filename from the upstream `behaviorHints` so Nuvio groups qualities and
labels the results properly.

The site's own playback path (`/api/play-lease` → `/api/mint-direct/api/v1/play`
with `X-Nflix-Play` / `X-Nflix-Lease` headers) is deliberately **not**
reimplemented here; it is an upstream concern and would couple this plugin to
the site's private API.

## Settings

`hasSettings` is enabled. Settings are optional; with none saved, every source
and resolution is returned. Both fields accept a JSON array or a comma
separated string:

```json
{
  "disabledSources": ["Nflx 1", "Pengu"],
  "disabledResolutions": ["360p", "480p"]
}
```

Sources are matched as substrings of the upstream `🛰️ Source:` label. On clients
without a settings UI (e.g. Android TV), edit `DEVICE_DEFAULTS` near the top of
`providers/nflixtv.js` instead.

## Differences from the Stremio addon

| Stremio addon | This plugin |
|---|---|
| Catalogs, search, meta | Not included — add the Stremio manifest separately if wanted |
| Configurable source/resolution checkboxes | Client-side filtering via the two settings above |
| Configurable via its manifest URL | Uses the endpoint's defaults, then filters locally |
| Runs on the addon host | Runs in Nuvio's on-device QuickJS runtime |

## Layout

```text
manifest.json                    Nuvio plugin repository manifest
providers/nflixtv.js             the provider (getStreams)
test/run.js                      Node test harness
test/fixtures/streams-*.json     recorded /stremio/stream responses
```

## Runtime constraints

The provider is Promise-chain based with ES2016 syntax: Nuvio's on-device
runtime does not reliably support `async`/`await` in loaded code and provides
no timers. `fetch` is the only network primitive, and there are no npm
dependencies to bundle. `AbortSignal.timeout` is used when the runtime offers
it, and any failure returns `[]` so other providers can still answer.

## Troubleshooting

- **No streams:** run `npm test`. A live failure usually means the site changed
  its `/stremio` API or that the host is blocking the request.
- **Streams appear but playback fails:** the signed URL may have expired between
  resolution and playback (the `t=` parameter). Re-open the title to re-resolve.
- **Plugin not listed:** the manifest URL must point at `manifest.json`; a
  provider URL in the Addons section will error.
