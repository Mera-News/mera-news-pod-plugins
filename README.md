# mera-news-pod-plugins

Plugins for [mera-news-pod](https://github.com/Mera-News/mera-news-pod), one package each under `packages/`. A plugin is how you reach your pod: it gets the pod's profile, suggestion and reading services and opens whatever connection it serves.

Plugins run inside the pod process with the pod's access to your profile, so only run plugins you trust.

This project is in development.

## Packages

- [`mcp`](packages/mcp): an MCP server, so an AI app can set up your profile and ask for new picks. Setup is in the pod's [connecting a client](https://github.com/Mera-News/mera-news-pod/blob/dev/docs/clients.md).
- [`sync`](packages/sync): pairs the Mera News app with your pod. Not available yet: the app cannot pair with a pod.
- [`starter`](packages/starter): a local page and three JSON routes for your picks. Copy it to start your own plugin; the pod's [plugin guide](https://github.com/Mera-News/mera-news-pod/blob/dev/docs/plugins.md) explains what a plugin gets.

To build and test them: `npm install`, then `npm run build`, `npm run typecheck` and `npm test`.

## Community plugins

Plugins other people keep in their own repositories. They are not reviewed by Mera Labs; only run plugins you trust. To add yours, see [submitting a plugin](CONTRIBUTING.md#submitting-a-plugin).

None yet.

## Licence

Copyright Mera Labs B.V.

Required Notice: Copyright Mera Labs B.V. (https://mera.news)

This code is source-available under the PolyForm Shield License 1.0.0. See `LICENSE`.

In short: you may run it, change it and build on it for any purpose, except to provide a product
that competes with this software or with a product Mera Labs provides using it, such as Mera News.
This summary is not the licence. The `LICENSE` file is.

Mera News and Mera Protocol are trademarks. See `TRADEMARK.md`.
For a use the licence does not allow, see `COMMERCIAL.md`.
To contribute, see `CONTRIBUTING.md`.
