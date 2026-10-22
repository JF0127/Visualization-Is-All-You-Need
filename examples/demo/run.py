#!/usr/bin/env python3
"""启动并监督 demo 的三个进程。

任意一个子进程退出时，停止其余进程；Ctrl+C / SIGTERM 时统一清理。
Windows 下也可以直接运行 ``python run.py``。
"""

import signal
import subprocess
import sys
import time
from pathlib import Path


BASE = Path(__file__).resolve().parent
SCRIPTS = ("plant.py", "controller.py", "sensor.py")


def terminate(children):
    for child in children:
        if child.poll() is None:
            try:
                child.terminate()
            except OSError:
                pass
    deadline = time.monotonic() + 3.0
    for child in children:
        remaining = max(0.0, deadline - time.monotonic())
        try:
            child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            pass
    for child in children:
        if child.poll() is None:
            try:
                child.kill()
            except OSError:
                pass
            try:
                child.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass


def main():
    children = []
    stopping = False

    def request_stop(signum, frame):
        nonlocal stopping
        stopping = True

    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), request_stop)

    try:
        for script in SCRIPTS:
            children.append(
                subprocess.Popen(
                    [sys.executable, "-u", str(BASE / script)],
                    cwd=str(BASE),
                )
            )
        while not stopping:
            for script, child in zip(SCRIPTS, children):
                code = child.poll()
                if code is not None:
                    print("%s 已退出（code=%s），停止其余进程。" % (script, code), file=sys.stderr)
                    return 0 if code == 0 else 1
            time.sleep(0.2)
        return 130
    except KeyboardInterrupt:
        return 130
    finally:
        terminate(children)


if __name__ == "__main__":
    raise SystemExit(main())
