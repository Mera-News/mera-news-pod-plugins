# mera-news-pod-sync

A plugin for mera-news-pod that a paired phone talks to. It serves the pod's tables, runs the app's
changes, and passes model and news requests through, all behind a device token.

The plugin speaks plain HTTP. Put a tunnel or a reverse proxy in front of it for HTTPS, and set
`publicHost` to the name the app reaches the pod at.

Settings in the plugin's section of `pod.json`: `host` (default `127.0.0.1`), `port` (default 8788),
`publicHost` and `podName`.

## Pairing

Run `mera-news-pod-sync pair --base https://<publicHost>` on the pod's machine. It prints a code and a
link for the app. The code has 10 characters, works once and lasts 10 minutes. After 10 wrong codes in
total, or 5 tries in a minute, pairing is refused until a new code is printed. Several phones can pair,
each with its own code. `mera-news-pod-sync devices` lists them and `devices --revoke <id>` removes one.

A phone may replace the pod's profile with its own only while it is the one paired device. Once a second phone has paired, neither can.

## Shared settings

A paired phone shares these settings with the pod and with every other paired phone, one value for all:
the language (which is also the language the pod writes reasons in), Skip notes, the 24-hour filter,
the Explore choices and the topics you rejected. The feed's card state stays on each device.
