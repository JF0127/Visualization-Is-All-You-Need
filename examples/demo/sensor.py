"""传感器进程：以 50 Hz 生成目标值（正弦）和带噪声的测量值，发送给控制器。"""

import math
import random
import socket
import time
from pathlib import Path

from common import HOST, load_config, probe, send_json, wait_for_next_tick


LOOP_HZ = 50.0


def generate_target(t, amplitude, frequency_hz):
    """生成目标信号：正弦波。"""
    return amplitude * math.sin(2 * math.pi * frequency_hz * t)


def add_noise(value, noise_std):
    """加高斯噪声。"""
    return value + random.gauss(0.0, noise_std)


def main():
    base_dir = Path(__file__).resolve().parent
    cfg = load_config(base_dir / "config.json")
    signal_cfg = cfg["signal"]
    addr = (HOST, int(cfg["ports"]["sensor_to_controller"]))

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    period = 1.0 / LOOP_HZ
    start = time.monotonic()
    next_tick = start

    try:
        while True:
            t = time.monotonic() - start
            target = generate_target(t, signal_cfg["amplitude"], signal_cfg["frequency_hz"])
            probe("target_value", target)
            measured = add_noise(target, signal_cfg["noise_std"])
            probe("sensor_sample", [target, measured])
            send_json(sock, addr, {"target": target, "measured": measured})
            next_tick = wait_for_next_tick(next_tick, period)
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()


if __name__ == "__main__":
    main()
