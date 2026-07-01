# Native navigation performance baseline

This runbook collects comparable FolioLens navigation timings from release-mode Android and iOS builds. Development Metro timings are not acceptance evidence: lazy bundling, debug logging, and automation latency distort the transitions being measured.

## Metrics

Every instrumented press emits two `navigation_performance` PostHog events and matching `[perf] navigation:` device-log lines:

- `phase=route_commit`: elapsed time from the press handler to the destination route's committed React render.
- `phase=post_interaction_usable`: elapsed time from the same press until React Native's active navigation interactions have drained.

The payload has only fixed route/transition names, `cache_state`, `sync_in_flight`, `active_query_count`, and aggregate `fund_count`, `transaction_count`, or `nav_row_count` values where available. It never contains a fund name, fund ID, user ID, pathname, transaction, or authentication value.

## Build and device record

Use the same commit for both platforms and do not compare a development build with a release build.

1. Create internal release builds from the implementation branch:

       npx eas-cli build --profile preview-pr --platform android
       npx eas-cli build --profile preview-pr --platform ios

2. Install the resulting APK on a physical Android device and the internal iOS build on a registered physical iPhone. If physical iOS signing or a registered device is unavailable, record that limitation; do not present simulator development timings as iOS release evidence.
3. On Settings → About & support, record:
   - app version;
   - EAS update channel;
   - full OTA update ID, or `Embedded (no OTA)`;
   - OTA date.
4. Also record the Git commit, EAS Android/iOS build IDs, device model, OS version, network type, and whether Low Power/Battery Saver mode is enabled.

## Capture logs

Android, with the installed release app closed:

    adb logcat -c
    adb logcat ReactNativeJS:V '*:S' | tee navigation-android.log

On iOS, connect the physical device to macOS, open Console.app, select the device, select the FolioLens process, and filter for `[perf] navigation:`. Export the filtered log after the run. For a release-configured Simulator build used only as supplemental evidence:

    xcrun simctl spawn booted log stream --level debug --predicate 'process == "FolioLens"' | tee navigation-ios.log

In PostHog, filter the `navigation_performance` event by the exact app version/update ID and group by `transition`, `phase`, `cache_state`, and `sync_in_flight`. PostHog supplies platform/device properties separately; the app payload deliberately keeps those out of its privacy allowlist.

## Test states

Use an account representative of the reported workload. Record the aggregate counts emitted by the harness; do not write fund or transaction details into the evidence sheet.

- Cold target: force-stop the app, relaunch, enter the source screen, and navigate to a destination not yet visited in that process. For Fund Detail, choose a holding whose detail route has not been opened since launch. Confirm `cache_state=cold` where that destination has a query cache probe.
- Warm target: visit the destination once, return to the source, wait two seconds with no visible loading indicator, and repeat. Confirm `cache_state=warm` where available.
- Sync overlap: do not deliberately trigger a sync for every sample. Preserve naturally occurring samples and separate `sync_in_flight=true` from `false` during analysis.

For each platform, capture at least five cold samples and ten warm samples for every applicable transition:

1. Portfolio → Settings.
2. Settings → About.
3. Funds → Fund Detail. The current Portfolio screen has no direct Fund Detail press; do not add one just for measurement.
4. Portfolio ↔ Funds, Portfolio ↔ Wealth Journey, and Funds ↔ Wealth Journey through the bottom tab bar. Desktop sidebar timings are supplemental and must not be mixed into the native bottom-tab baseline.

Avoid rapid double taps during the standard run. The harness supports overlapping presses for correctness testing, but those samples answer a different question and should be labelled separately.

## Evidence sheet

Keep raw samples and calculate median and p95 separately for route commit and post-interaction usability. With fewer than 20 samples, use the nearest-rank p95 rather than interpolation.

| Platform | Build/update ID | Device / OS | Transition | State | Sync active | Sample count | Commit median | Commit p95 | Usable median | Usable p95 |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|
| Android |  |  | Portfolio → Settings | cold | false | 5 |  |  |  |  |
| Android |  |  | Portfolio → Settings | warm | false | 10 |  |  |  |  |
| iOS |  |  | Portfolio → Settings | cold | false | 5 |  |  |  |  |
| iOS |  |  | Portfolio → Settings | warm | false | 10 |  |  |  |  |

Copy the rows for the remaining transitions. Attach the raw filtered logs or a CSV export from PostHog to the implementation PR. Flag samples with `sync_in_flight=true`; report them as a separate cohort rather than deleting them.

## Interpretation

- High route-commit time means the press competed with JavaScript work before the destination committed.
- Low commit but high usable time means route animation, destination rendering, or queued interactions dominated.
- A warm/cold gap points to route evaluation or data/cache readiness.
- A sync-active gap supports contention from background lifecycle work.

N1 establishes observation only. Do not tune prefetches, freeze screens, change invalidation, or alter data-fetching behavior while collecting this baseline.
