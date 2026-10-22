"""通过 UDP 发送观测数据。

目标是“尽量不影响被测程序”：
- socket 在导入时解析一次目标地址，之后用非阻塞 ``sendto``；
- 使用非阻塞发送，接收端繁忙时丢弃当前样本而不是卡住调用方；
- 对 numpy / Decimal / 非有限浮点数做安全归一化；
- 序列化或发送失败默认静默，``PROBE_DEBUG=1`` 时打印第一次失败原因。
"""

import atexit
import json
import math
import os
import socket
import sys
import time


_DEFAULT_HOST = "127.0.0.1"
_DEFAULT_PORT = 8766

_debug = os.environ.get("PROBE_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")
_stats = {"sent": 0, "dropped": 0, "errors": 0}
_reported_error = False
_socket = None
_destination = None


def _report(message):
    global _reported_error
    if not _debug or _reported_error:
        return
    _reported_error = True
    try:
        print("[probe] " + message, file=sys.stderr, flush=True)
    except Exception:
        pass


def _close():
    global _socket
    if _socket is not None:
        try:
            _socket.close()
        except OSError:
            pass
        _socket = None


def _connect():
    global _socket, _destination
    host = os.environ.get("PROBE_HOST", _DEFAULT_HOST)
    try:
        port = int(os.environ.get("PROBE_PORT", str(_DEFAULT_PORT)))
    except ValueError:
        _report("PROBE_PORT 不是整数，打点已禁用")
        return
    try:
        info = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)[0]
        family, socktype, proto, _canonname, destination = info
        sock = socket.socket(family, socktype, proto)
        sock.setblocking(False)
    except OSError as error:
        _report("无法连接 %s:%s（%s），打点已禁用" % (host, port, error))
        return
    _socket = sock
    _destination = destination
    atexit.register(_close)


_connect()


def _clean(value, depth=0):
    """把常见 Python/numpy 类型转换成 JSON 可序列化的值。"""
    if depth > 12:
        return str(value)
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, dict):
        return {str(key): _clean(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item, depth + 1) for item in value]

    # numpy 标量 / 数组、Decimal、自定义数值对象。
    for attribute in ("item", "tolist"):
        method = getattr(value, attribute, None)
        if callable(method):
            try:
                converted = method()
            except (TypeError, ValueError, OverflowError):
                continue
            if converted is not value:
                return _clean(converted, depth + 1)
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return str(value)
    return number if math.isfinite(number) else None


def _encode(name, value, timestamp):
    payload = {"name": name, "t": timestamp, "value": value}
    try:
        return json.dumps(
            payload, allow_nan=False, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError, RecursionError):
        payload["value"] = _clean(value)
        return json.dumps(
            payload, allow_nan=False, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")


def probe(name, value, timestamp=None):
    """发送一个采样点。

    name 应为非空字符串；value 可以是 JSON 标量、列表或字典。
    序列化/发送失败时静默忽略，不影响调用方。
    """
    if _socket is None:
        return False

    try:
        name = str(name)
    except Exception as error:
        _stats["dropped"] += 1
        _report("名称无法转换：%r" % (error,))
        return False
    if not name:
        return False
    if timestamp is None:
        timestamp = time.time()
    elif isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or not math.isfinite(float(timestamp)):
        timestamp = time.time()

    try:
        data = _encode(name, value, timestamp)
    except Exception as error:
        _stats["dropped"] += 1
        _report("值无法序列化：%r" % (error,))
        return False

    try:
        _socket.sendto(data, _destination)
    except (BlockingIOError, InterruptedError):
        _stats["dropped"] += 1
        return False
    except Exception as error:
        _stats["dropped"] += 1
        _stats["errors"] += 1
        _report("发送失败：%r" % (error,))
        return False
    _stats["sent"] += 1
    return True


def stats():
    """返回当前进程的发送计数，便于调试。"""
    return dict(_stats)


__all__ = ["probe", "stats"]
