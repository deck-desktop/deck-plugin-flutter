# Flutter

Launch a Flutter app on a device, then hot reload it without leaving Deck.

It watches the terminal panes for a `flutter run`, attaches to the one it finds, and gives you
reload, restart and stop from the footer - plus a log panel that understands Flutter's output:
`developer.log` records, stack frames with clickable files, and framework errors separated from
ordinary prints.

## What it exports

| Export | Where it renders |
|---|---|
| `Status` | the footer readout: the running app, and reload/restart/stop |
| `Panel` | the log panel, beside Console in the footer drawer |
| `PaneView` | the log as a pane in the split tree, if you would rather it stayed visible |
| `commands` | palette entries for run, reload, restart and stop |
| `mcp` | the same actions, for an agent |

## Checks

```sh
node plugins/flutter/flutter.check.mjs
```

Detecting a `flutter run` in a pane, and parsing the device list.

## Build

```sh
node plugins/flutter/build.mjs
```

See [../README.md](../README.md) for how the build and the shims work.

## Install

Copy `plugin.json` and `plugin.js`, `mcp.js` into `%APPDATA%\Deck\plugins\flutter\` (`Deck-Dev` for a
debug build) and restart Deck.
