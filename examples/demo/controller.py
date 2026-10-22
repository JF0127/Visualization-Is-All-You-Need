"""控制器进程：滑动平均滤波 + PID 控制，50 Hz 运行，并把每个周期的数据写入 CSV 日志。"""

import csv
import socket
import time
from collections import deque
from pathlib import Path

from common import (
    HOST,
    bind_udp,
    load_config,
    probe,
    recv_latest,
    send_json,
    wait_for_next_tick,
)


LOOP_HZ = 50.0
LOG_FLUSH_SECONDS = 0.5
CSV_HEADER = ["time", "target", "filtered", "position", "command"]


def moving_average(window):
    """滑动平均滤波：窗口内测量值的平均值。"""
    if not window:
        return 0.0
    return sum(window) / len(window)


def pid_step(state, error, dt, kp, ki, kd):
    """PID 计算。state 保存积分项和上一次误差。"""
    state["integral"] += error * dt
    if state["prev_error"] is None:
        derivative = 0.0
    else:
        derivative = (error - state["prev_error"]) / dt
    state["prev_error"] = error
    return kp * error + ki * state["integral"] + kd * derivative


def open_log(path):
    """打开日志文件并写入表头；调用方负责 flush/close。"""
    handle = open(path, "w", newline="", encoding="utf-8")
    writer = csv.writer(handle)
    writer.writerow(CSV_HEADER)
    return handle, writer


def main():
    base_dir = Path(__file__).resolve().parent
    cfg = load_config(base_dir / "config.json")
    ports = cfg["ports"]
    pid_cfg = cfg["pid"]
    window_size = int(cfg["filter"]["window_size"])

    sensor_sock = bind_udp(ports["sensor_to_controller"])
    plant_sock = bind_udp(ports["plant_to_controller"])
    cmd_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    cmd_addr = (HOST, int(ports["controller_to_plant"]))

    log_dir = base_dir / "logs"
    log_dir.mkdir(exist_ok=True)
    log_path = log_dir / ("controller_" + time.strftime("%Y%m%d_%H%M%S") + ".csv")
    log_handle, log_writer = open_log(log_path)

    window = deque(maxlen=window_size)
    pid_state = {"integral": 0.0, "prev_error": None}
    target = 0.0
    position = 0.0
    period = 1.0 / LOOP_HZ
    start = time.monotonic()
    next_tick = start
    last_flush = start

    try:
        while True:
            elapsed = time.monotonic() - start

            sensor_msg = recv_latest(sensor_sock)
            if sensor_msg is not None:
                try:
                    target = float(sensor_msg["target"])
                    window.append(float(sensor_msg["measured"]))
                except (KeyError, TypeError, ValueError):
                    pass

            plant_msg = recv_latest(plant_sock)
            if plant_msg is not None:
                try:
                    position = float(plant_msg["position"])
                except (KeyError, TypeError, ValueError):
                    pass

            filtered = moving_average(window)
            error = filtered - position
            command = pid_step(
                pid_state, error, period, pid_cfg["kp"], pid_cfg["ki"], pid_cfg["kd"]
            )

            probe("control_command", command)
            send_json(cmd_sock, cmd_addr, {"command": command})
            row = [round(elapsed, 4), target, filtered, position, command]
            probe("cycle_log_record", row)
            log_writer.writerow(row)
            now = time.monotonic()
            if now - last_flush >= LOG_FLUSH_SECONDS:
                log_handle.flush()
                last_flush = now

            next_tick = wait_for_next_tick(next_tick, period)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            log_handle.flush()
        except OSError:
            pass
        log_handle.close()
        sensor_sock.close()
        plant_sock.close()
        cmd_sock.close()


if __name__ == "__main__":
    main()
