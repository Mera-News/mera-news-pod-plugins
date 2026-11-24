# mera-news-pod-web

The Mera News website for your pod: your news, top stories and your profile, in your browser. The
pod serves it on `127.0.0.1` only, so it opens on the computer the pod runs on and nowhere else.

This first version is the frame of the site: Feed, World and You, and on You what the pod knows
about you and how it reads. The news itself comes in the next versions.

## Opening it

The site opens from a link that works once, for 10 minutes, in one browser tab:

- With the Mera News plugin or extension in an AI app, ask your assistant to open Mera News. It
  calls the `open_news_site` tool for the link.
- With a pod you run yourself, run `mera-news-pod-web link --home <your pod folder>`.

A new tab needs a new link, and a restart of the pod ends every open tab's session.

## In pod.json

```json
{ "package": "mera-news-pod-web", "config": { "port": 8790 } }
```

Put it after the `mcp` plugin. `port` defaults to 8790. When the port is taken, the site takes a free
one and writes it to `address.json` in its data folder, where the link command reads it.

## What it allows

- Only requests addressed to `127.0.0.1:<port>` or `localhost:<port>`, and from that origin.
- `GET` and `HEAD` for the pages, `POST` with a JSON body of up to 64 KiB for the API. No other
  method, and no other site can call it.
- The pages run only their own scripts. Publishers' images load over https; nothing else is
  fetched from another host.

The site shows headlines and links to the publishers' sites. Articles belong to their publishers:
read them on the publisher's site, and subscribe to the ones you value.

## Building

`npm run build` compiles the plugin (`src/`) and exports the site (`site/`, a Next.js app) to
`site/out`, which the plugin serves. `notices.json` lists every package whose code reaches the
browser, for the licence notices that ship with the AI app plugin.
