"""通过 UDP 发送观测数据，使用 PROBE_HOST 和 PROBE_PORT 覆盖目标地址。"""

import json
import os
import socket
import time


try:
    _destination = (
        os.environ.get("PROBE_HOST", "127.0.0.1"),
        int(os.environ.get("PROBE_PORT", "8766")),
    )
    _socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
except (OSError, ValueError):
    _socket = None


def probe(name, value):
    """发送名称、当前 Unix 时间和原始值；序列化或发送失败时静默忽略。"""
    if _socket is None:
        return

    try:
        payload = {"name": name, "t": time.time(), "value": value}
        data = json.dumps(payload).encode("utf-8")
        _socket.sendto(data, _destination)
    except Exception:
        pass
