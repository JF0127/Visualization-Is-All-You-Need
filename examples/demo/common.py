"""demo 三个进程共用的配置、UDP 和节拍工具。"""

import json
import socket
import sys
import time
from pathlib import Path


HOST = "127.0.0.1"
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from probe import probe  # noqa: E402  (需要先把仓库根目录加入 sys.path)


def load_config(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def bind_udp(port):
    """创建本机 UDP 监听套接字（非阻塞）。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((HOST, int(port)))
    sock.setblocking(False)
    return sock


def recv_latest(sock):
    """非阻塞读走缓冲区，只解析最新一包；没有合法数据则返回 None。"""
    latest = None
    while True:
        try:
            data, _ = sock.recvfrom(65535)
        except (BlockingIOError, InterruptedError):
            break
        except OSError:
            break
        latest = data
    if latest is None:
        return None
    try:
        payload = json.loads(latest.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def send_json(sock, addr, payload):
    """发送紧凑 JSON；失败不打断调用方。"""
    try:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        sock.sendto(data, addr)
        return True
    except (OSError, TypeError, ValueError, OverflowError):
        return False


def wait_for_next_tick(next_tick, period):
    """按固定周期睡眠，返回下一个节拍的时刻。"""
    next_tick += period
    delay = next_tick - time.monotonic()
    if delay > 0:
        time.sleep(delay)
    else:
        next_tick = time.monotonic()
    return next_tick
