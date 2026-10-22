"""电机进程：一阶惯性模型，100 Hz 更新位置，并把位置发送给控制器。"""

import socket
import time
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


LOOP_HZ = 100.0
TIME_CONSTANT = 0.2


def motor_step(position, velocity, command, dt, tau):
    """电机模型更新：速度以一阶惯性趋近控制量，位置对速度积分。"""
    velocity += (command - velocity) * dt / tau
    position += velocity * dt
    return position, velocity


def main():
    base_dir = Path(__file__).resolve().parent
    cfg = load_config(base_dir / "config.json")
    ports = cfg["ports"]

    cmd_sock = bind_udp(ports["controller_to_plant"])
    pos_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    pos_addr = (HOST, int(ports["plant_to_controller"]))

    period = 1.0 / LOOP_HZ
    position = 0.0
    velocity = 0.0
    command = 0.0
    next_tick = time.monotonic()

    try:
        while True:
            cmd_msg = recv_latest(cmd_sock)
            if cmd_msg is not None:
                try:
                    command = float(cmd_msg["command"])
                except (KeyError, TypeError, ValueError):
                    pass

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
