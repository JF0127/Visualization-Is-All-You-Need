"""控制器进程：滑动平均滤波 + PID 控制，50 Hz 运行，并把每个周期的数据写入 CSV 日志。"""
import csv
import json
import os
import socket
import sys
import time
from collections import deque

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "probe")))
from probe import probe

HOST = "127.0.0.1"
LOOP_HZ = 50.0


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def bind_udp(port):
    """创建本机 UDP 监听套接字（非阻塞）。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((HOST, port))
    sock.setblocking(False)
    return sock


def recv_latest(sock):
    """非阻塞读取缓冲区中所有数据包，只返回最新的一个；没有数据则返回 None。"""
    latest = None
    while True:
        try:
            data, _ = sock.recvfrom(65535)
        except BlockingIOError:
            break
        latest = json.loads(data.decode("utf-8"))
    return latest


def send_json(sock, addr, payload):
    sock.sendto(json.dumps(payload).encode("utf-8"), addr)


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


def init_log_file(path):
    with open(path, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(["time", "target", "filtered", "position", "command"])


def write_log_row(path, row):
    """追加一行日志。"""
    with open(path, "a", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(row)


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
    ports = cfg["ports"]
    pid_cfg = cfg["pid"]
    window_size = cfg["filter"]["window_size"]

    sensor_sock = bind_udp(ports["sensor_to_controller"])
    plant_sock = bind_udp(ports["plant_to_controller"])
    cmd_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    cmd_addr = (HOST, ports["controller_to_plant"])

    log_dir = os.path.join(base_dir, "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "controller_" + time.strftime("%Y%m%d_%H%M%S") + ".csv")
    init_log_file(log_path)

    window = deque(maxlen=window_size)
    pid_state = {"integral": 0.0, "prev_error": None}
    target = 0.0
    position = 0.0
    period = 1.0 / LOOP_HZ
    start = time.monotonic()
    next_tick = start

    try:
        while True:
            elapsed = time.monotonic() - start

            sensor_msg = recv_latest(sensor_sock)
            if sensor_msg is not None:
                target = float(sensor_msg["target"])
                window.append(float(sensor_msg["measured"]))

            plant_msg = recv_latest(plant_sock)
            if plant_msg is not None:
                position = float(plant_msg["position"])

            filtered = moving_average(window)
            error = filtered - position
            command = pid_step(pid_state, error, period, pid_cfg["kp"], pid_cfg["ki"], pid_cfg["kd"])

            probe("control_command", command)
            send_json(cmd_sock, cmd_addr, {"command": command})
            probe("cycle_log_record", [round(elapsed, 4), target, filtered, position, command])
            write_log_row(log_path, [round(elapsed, 4), target, filtered, position, command])

            next_tick = wait_for_next_tick(next_tick, period)
    except KeyboardInterrupt:
        pass
    finally:
        sensor_sock.close()
        plant_sock.close()
        cmd_sock.close()


if __name__ == "__main__":
    main()
