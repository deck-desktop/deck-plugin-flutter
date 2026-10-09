# Flutter

Launch a Flutter app on a device, then hot reload it without leaving Deck.

It watches the terminal panes for a `flutter run`, attaches to the one it finds, and gives you
reload, restart and stop from the footer - plus a log panel that understands Flutter's output:
`developer.log` records, stack frames with clickable files, and framework errors separated from
ordinary prints.

The panel's **Network** view lists the app's HTTP calls - method, status, timing, size, headers
and bodies, with copy-as-cURL - read from the VM Service's dart:io HTTP profile, the same source
as the Network tab in Flutter's DevTools. The app needs no interceptor or package. It covers
anything built on dart:io's `HttpClient` (package:http, dio's default adapter); it does not cover
Flutter web, native adapters such as `cupertino_http` or `cronet_http`, or native SDKs. A call
made before the plugin attaches to the app (in the first moments of `main`) is not recorded.

## What it exports

| Export | Where it renders |
|---|---|
| `Status` | the footer readout: the running app, and reload/restart/stop |
| `Panel` | the log and Network panel, beside Console in the footer drawer |
| `PaneView` | the log as a pane in the split tree, if you would rather it stayed visible |
| `commands` | palette entries for run, reload, restart and stop |
| `mcp` | the same actions, for an agent |

## Checks

```sh
node plugins/flutter/flutter.check.mjs
```

Detecting a `flutter run` in a pane, parsing the device list, and reading the HTTP profile.

## Build

```sh
node plugins/flutter/build.mjs
```

See [../README.md](../README.md) for how the build and the shims work.

## Install

Copy `plugin.json` and `plugin.js`, `mcp.js` into `%APPDATA%\Deck\plugins\flutter\` (`Deck-Dev` for a
debug build) and restart Deck.
