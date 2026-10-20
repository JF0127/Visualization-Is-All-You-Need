"""电机进程：一阶惯性模型，100 Hz 更新位置，并把位置发送给控制器。"""
import json
import os
import socket
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "probe")))
from probe import probe

HOST = "127.0.0.1"
LOOP_HZ = 100.0
TIME_CONSTANT = 0.2


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


def motor_step(position, velocity, command, dt, tau):
    """电机模型更新：速度以一阶惯性趋近控制量，位置对速度积分。"""
    velocity += (command - velocity) * dt / tau
    position += velocity * dt
    return position, velocity


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

    cmd_sock = bind_udp(ports["controller_to_plant"])
    pos_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    pos_addr = (HOST, ports["plant_to_controller"])

    period = 1.0 / LOOP_HZ
    position = 0.0
    velocity = 0.0
    command = 0.0
    next_tick = time.monotonic()

    try:
        while True:
            cmd_msg = recv_latest(cmd_sock)
            if cmd_msg is not None:
                command = float(cmd_msg["command"])

            probe("applied_command", command)
            position, velocity = motor_step(position, velocity, command, period, TIME_CONSTANT)
            probe("simulated_position", position)
            probe("position_feedback", position)
            send_json(pos_sock, pos_addr, {"position": position})

            next_tick = wait_for_next_tick(next_tick, period)
    except KeyboardInterrupt:
        pass
    finally:
        cmd_sock.close()
        pos_sock.close()


if __name__ == "__main__":
    main()
