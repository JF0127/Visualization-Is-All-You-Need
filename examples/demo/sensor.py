"""传感器进程：以 50 Hz 生成目标值（正弦）和带噪声的测量值，发送给控制器。"""
import json
import math
import os
import random
import socket
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "probe")))
from probe import probe

HOST = "127.0.0.1"
LOOP_HZ = 50.0


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def generate_target(t, amplitude, frequency_hz):
    """生成目标信号：正弦波。"""
    return amplitude * math.sin(2 * math.pi * frequency_hz * t)


def add_noise(value, noise_std):
    """加高斯噪声。"""
    return value + random.gauss(0.0, noise_std)


def send_json(sock, addr, payload):
    sock.sendto(json.dumps(payload).encode("utf-8"), addr)


def wait_for_next_tick(next_tick, period):
    """按固定周期睡眠，返回下一个节拍的时刻。"""
    next_tick += period
    delay = next_tick - time.monotonic()
    if delay > 0:
        time.sleep(delay)
    else:
        next_tick = time.monotonic()
    return next_tick


def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    cfg = load_config(os.path.join(base_dir, "config.json"))
    signal_cfg = cfg["signal"]
    addr = (HOST, cfg["ports"]["sensor_to_controller"])

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
