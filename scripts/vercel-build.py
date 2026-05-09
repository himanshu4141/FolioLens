#!/usr/bin/env python3
"""Deterministic Expo web export for Vercel.

Expo Router static rendering can finish writing `dist/` but leave Metro or
worker handles alive long enough for Vercel to think the build is still
running. This wrapper streams the normal Expo logs, waits for a successful
`Exported: dist`, then gives the process a short grace window to exit on its
own before terminating the whole process group.
"""

from __future__ import annotations

import os
import select
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = ROOT / "dist"
SUCCESS_MARKER = "Exported: dist"
GRACE_SECONDS = int(os.environ.get("VERCEL_BUILD_GRACE_SECONDS", "15"))
HARD_TIMEOUT_SECONDS = int(os.environ.get("VERCEL_BUILD_TIMEOUT_SECONDS", str(15 * 60)))


def terminate_process_group(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return

    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return

    deadline = time.monotonic() + 5
    while proc.poll() is None and time.monotonic() < deadline:
        time.sleep(0.2)

    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main() -> int:
    command = shlex.split(
        os.environ.get("VERCEL_BUILD_COMMAND", "npx expo export --platform web")
    )

    # Gate Vercel Web Analytics + Speed Insights to "real" deploys: the PROD
    # project's tag-pushed deploy and the DEV project's main-merge deploy
    # (both report VERCEL_ENV=production). Per-PR previews on the DEV project
    # report VERCEL_ENV=preview and stay quiet.
    #
    # PostHog uses the same gate. On non-production builds we explicitly strip
    # any EXPO_PUBLIC_POSTHOG_KEY / _HOST present in the env so a Vercel
    # variable misscoped to "All Environments" can't leak a real key into a
    # PR-preview bundle.
    build_env = os.environ.copy()
    if build_env.get("VERCEL_ENV") == "production":
        build_env["EXPO_PUBLIC_ENABLE_INSIGHTS"] = "1"
    else:
        build_env.pop("EXPO_PUBLIC_POSTHOG_KEY", None)
        build_env.pop("EXPO_PUBLIC_POSTHOG_HOST", None)

    proc = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
        env=build_env,
    )

    exported_at: float | None = None
    started_at = time.monotonic()

    assert proc.stdout is not None
    while True:
        ready, _, _ = select.select([proc.stdout], [], [], 0.5)
        if ready:
            line = proc.stdout.readline()
            if line:
                sys.stdout.write(line)
                sys.stdout.flush()
                if SUCCESS_MARKER in line:
                    exported_at = time.monotonic()

        exit_code = proc.poll()
        if exit_code is not None:
            if exported_at is not None and DIST_DIR.exists():
                return 0
            return exit_code

        now = time.monotonic()
        if exported_at is not None and DIST_DIR.exists() and now - exported_at >= GRACE_SECONDS:
            print("Expo export completed; terminating lingering build processes.")
            terminate_process_group(proc)
            return 0 if DIST_DIR.exists() else 1

        if now - started_at >= HARD_TIMEOUT_SECONDS:
            print("Expo export timed out before finishing.")
            terminate_process_group(proc)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
