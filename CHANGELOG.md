# Changelog

## Unreleased

- FVM: an app runs on the Flutter its project pins (.fvmrc), and the run menu says which Flutter
  that is. Its version row lets you use another installed version for this session, pin one for
  the project (`fvm use`, after a confirm), install a release in a terminal (`fvm install`), or use
  the Flutter on PATH. A pinned version that is not installed says so, with Install with FVM (or
  How to install FVM) and Run with the PATH version. The log's first line, the run's tab and the
  footer's tooltip name the SDK. Without FVM and without a pin, nothing changes.

## 1.6.0 (2026-11-12)

- In a project with several folders (Deck 1.17.3), Flutter finds the apps in every folder.

## 1.5.0 (2026-11-05)

- The run menu lists the Android emulators that are off, below the devices. Picking one starts it
  and runs the app on it once it has booted.

## 1.4.0 (2026-11-01)

- Runs on Linux: its tools start without cmd /C and its processes are found by name. Needs Deck 1.15.0.

## 1.3.3 (2026-10-30)

- A licence, this changelog, a README rewritten with a screenshot, and the permissions it uses
  declared. Built from its own lockfile.

## 1.3.2 (2026-10-28)

- A run shows in every workspace whose folder holds it

## 1.3.1 (2026-10-25)

- One date/number formatter per list, not one per row

## 1.3.0 (2026-10-18)

- The first version in Deck's plugin registry.
