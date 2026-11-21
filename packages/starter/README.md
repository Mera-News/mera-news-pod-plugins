# mera-news-pod-starter

The smallest plugin worth copying. It serves a local page that lists your picks, and three JSON
routes that return the same data. Copy this folder to start your own plugin: the whole plugin is
`src/index.ts`, read it top to bottom.

## What it serves

It listens on `127.0.0.1` only. The port is `port` in the plugin's section of pod.json, default 8789.

- `GET /`: the page. It needs no token because it holds no data. Put the token after a `#` in the
  address and the page lists each pick as a headline with its publication, linked to the article.
- `GET /picks?since=<cursor>&limit=<n>`: picks. `since` defaults to `all`, `limit` to 20 (1 to 50).
- `GET /profile?offset=<n>`: the saved facts and their topics.
- `GET /status`: the pod's reading status.

The three routes need `Authorization: Bearer <token>`.

## Publishers' content

Show the headline and the link, and send the reader to the publisher's site. Do not fetch, scrape, copy or summarise article text from a publisher's site: that may breach the publisher's copyright. A plugin that helps readers subscribe to publishers they value is welcome.

The page says so under the picks.

## The token

The token is the file `token` in the plugin's data folder (`<home>/data/plugins/starter/token`). It is
created at start when missing, readable only by you, and read again on every request, so replacing
the file takes effect at once. `mera-news-pod check` prints where it is. The plugin never prints it.

## Reading picks without taking them

A reader that only shows picks passes `peek: true` to `suggestions.get`. Without it, the picks you
show are marked as delivered and another caller, such as the MCP server, no longer gets them.
