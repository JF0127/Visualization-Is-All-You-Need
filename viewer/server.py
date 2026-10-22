"""接收 UDP 打点数据，并通过本地 HTTP 服务提供监测页面、模块说明和缓存数据。

设计目标：
- 打点不阻塞被测程序：接收线程独立、缓存操作短小；
- 时间戳可容错：本机时钟偏差不会让页面永久停更；
- 页面只读：所有 GET 接口都限定在 loopback 或显式指定的监听地址上。
"""

import argparse
import json
import math
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


VERSION = "0.3.0"
RETENTION_SECONDS = 30.0
# 未来时间戳超过这个偏差、或过去时间戳超过 PAST_SKEW_SECONDS 时，
# 改用服务端接收时间，避免时钟问题污染整个时间窗口。
FUTURE_SKEW_SECONDS = 0.1
PAST_SKEW_SECONDS = 0.25
# 停止打点的数据名在 /names 中保留一段时间，供页面显示“已停止”。
LATEST_TTL_SECONDS = 300.0
# add() 最多每 0.5 秒做一次全量清理，包处理路径保持 O(1)。
PRUNE_INTERVAL_SECONDS = 0.5
MAX_NAME_LENGTH = 256
MAX_NAMES_PER_QUERY = 512
MAX_PACKET_BYTES = 16384
# 单个数据名的内存上限；超过后保留最新点，避免异常高频打点耗尽内存。
MAX_POINTS_PER_NAME = 60000

ASSETS = {
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/model.mjs": ("model.mjs", "text/javascript; charset=utf-8"),
    "/theme-init.js": ("theme-init.js", "text/javascript; charset=utf-8"),
}


class Stats:
    """接收线程共享的轻量计数，供 /stats 与 /healthz 使用。"""

    def __init__(self):
        self._lock = threading.Lock()
        self.started_at = time.time()
        self.packets = 0
        self.valid = 0
        self.invalid = 0
        self.skewed = 0
        self.bytes = 0
        self.last_packet_at = None
        self.receiver_alive = False
        self.last_error = ""

    def received(self, size):
        with self._lock:
            self.packets += 1
            self.bytes += size
            self.last_packet_at = time.time()
            self.receiver_alive = True
            self.last_error = ""

    def accepted(self, skewed):
        with self._lock:
            self.valid += 1
            if skewed:
                self.skewed += 1

    def rejected(self):
        with self._lock:
            self.invalid += 1

    def set_receiver(self, alive, error=""):
        with self._lock:
            self.receiver_alive = alive
            if error:
                self.last_error = error
            elif alive:
                self.last_error = ""

    def snapshot(self):
        with self._lock:
            return {
                "receiver_alive": self.receiver_alive,
                "packets": self.packets,
                "valid": self.valid,
                "invalid": self.invalid,
                "skewed": self.skewed,
                "bytes": self.bytes,
                "last_packet": self.last_packet_at,
                "last_error": self.last_error,
                "started_at": self.started_at,
                "uptime": max(0.0, time.time() - self.started_at),
            }


class DataCache:
    """按数据名保留最近若干秒的采样点。

    时间戳来自探针；未来偏差超过 FUTURE_SKEW_SECONDS、或过去偏差超过
    PAST_SKEW_SECONDS 时改用接收时间，保证窗口始终以本机时间为准。
    """

    def __init__(self, retention=RETENTION_SECONDS):
        self._lock = threading.Lock()
        self._points = {}
        self._latest = {}
        self._retention = float(retention)
        self._last_prune = 0.0

    def _prune_locked(self, now):
        cutoff = now - self._retention
        latest_cutoff = now - LATEST_TTL_SECONDS
        for name, points in list(self._points.items()):
            # 包可能乱序，不能只从头部删除。
            recent = [point for point in points if point[0] >= cutoff]
            if len(recent) > MAX_POINTS_PER_NAME:
                recent = recent[-MAX_POINTS_PER_NAME:]
            if recent:
                self._points[name] = recent
            else:
                del self._points[name]
        for name, timestamp in list(self._latest.items()):
            if timestamp < latest_cutoff:
                del self._latest[name]
        self._last_prune = now

    def _maybe_prune_locked(self, now):
        if now - self._last_prune >= PRUNE_INTERVAL_SECONDS:
            self._prune_locked(now)

    def add(self, name, timestamp, value, received_at=None):
        """写入一个采样点，返回 (accepted, skewed)。

        received_at 由接收线程在收到包时记录，避免每个包重复调用 time.time()。
        """
        now = time.time() if received_at is None else received_at
        skewed = False
        if (
            not math.isfinite(timestamp)
            or timestamp > now + FUTURE_SKEW_SECONDS
            or timestamp < now - PAST_SKEW_SECONDS
        ):
            timestamp = now
            skewed = True
        with self._lock:
            self._points.setdefault(name, []).append([timestamp, value])
            previous = self._latest.get(name)
            if previous is None or timestamp > previous:
                self._latest[name] = timestamp
            self._maybe_prune_locked(now)
        return True, skewed

    def prune(self):
        with self._lock:
            self._prune_locked(time.time())

    def data(self, names, since):
        now = time.time()
        with self._lock:
            self._maybe_prune_locked(now)
            result = {}
            for name in names:
                points = self._points.get(name, [])
                if since is None:
                    result[name] = [point[:] for point in points]
                else:
                    result[name] = [point[:] for point in points if point[0] > since]
            return result

    def names(self):
        now = time.time()
        with self._lock:
            self._maybe_prune_locked(now)
            # 过期后仍保留最近时间戳，供页面判断“数据已停止”。
            return dict(self._latest)

    @property
    def retention(self):
        return self._retention

    def counts(self):
        with self._lock:
            self._maybe_prune_locked(time.time())
            return {
                "names": len(self._latest),
                "active_names": len(self._points),
                "points": sum(len(points) for points in self._points.values()),
            }


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Expected a finite number")
    return number


def reject_json_constant(value):
    raise ValueError("Invalid JSON constant: " + value)


def receive_udp(udp_socket, cache, stats, stop_event):
    stats.set_receiver(True)
    try:
        while not stop_event.is_set():
            try:
                packet, _ = udp_socket.recvfrom(65535)
            except socket.timeout:
                cache.prune()
                continue
            except OSError as error:
                if stop_event.is_set():
                    return
                stats.set_receiver(False, "UDP 接收失败：" + str(error))
                time.sleep(0.2)
                continue

            received_at = time.time()
            stats.received(len(packet))
            if len(packet) > MAX_PACKET_BYTES:
                stats.rejected()
                continue
            try:
                message = json.loads(
                    packet.decode("utf-8"),
                    parse_float=finite_float,
                    parse_constant=reject_json_constant,
                )
                if not isinstance(message, dict):
                    raise ValueError("payload must be an object")
                name = message.get("name")
                timestamp = message.get("t")
                if not isinstance(name, str) or not name or len(name) > MAX_NAME_LENGTH:
                    raise ValueError("invalid name")
                if "value" not in message:
                    raise ValueError("missing value")
                if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
                    raise ValueError("invalid timestamp")
                timestamp = finite_float(timestamp)
            except (ValueError, TypeError, OverflowError, RecursionError, UnicodeDecodeError):
                stats.rejected()
                continue

            try:
                _, skewed = cache.add(name, timestamp, message["value"], received_at)
                stats.accepted(skewed)
            except (MemoryError, RecursionError):
                stats.rejected()
    finally:
        stats.set_receiver(False)


def make_handler(project_dir, cache, stats, verbose=False):
    viewer_dir = Path(__file__).resolve().parent
    index_path = viewer_dir / "index.html"
    module_path = project_dir / "module.md"

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "P025Viewer/" + VERSION
        sys_version = ""

        def version_string(self):
            return self.server_version

        def log_message(self, fmt, *args):
            if verbose:
                sys.stderr.write(
                    "%s - - [%s] %s\n"
                    % (self.address_string(), self.log_date_time_string(), fmt % args)
                )

        def end_headers(self):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
                "form-action 'none'; frame-ancestors 'none'",
            )
            super().end_headers()

        def send_body(self, status, content_type, body):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

        def send_json(self, value, status=200):
            try:
                body = json.dumps(
                    value, allow_nan=False, ensure_ascii=False, separators=(",", ":")
                ).encode("utf-8")
            except (TypeError, ValueError, OverflowError):
                self.send_error(500, "Unable to encode response")
                return
            self.send_body(status, "application/json; charset=utf-8", body)

        def send_file(self, path, content_type):
            try:
                body = path.read_bytes()
            except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
                self.send_error(404, "File not found")
                return
            except PermissionError:
                self.send_error(403, "Permission denied")
                return
            except OSError:
                self.send_error(500, "Unable to read file")
                return
            self.send_body(200, content_type, body)

        def do_GET(self):
            try:
                self.route()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            except Exception as error:  # noqa: BLE001 - 兜底，避免请求线程静默死亡
                if verbose:
                    self.log_error("request failed: %r", error)
                try:
                    self.send_error(500, "Internal server error")
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True

        def do_HEAD(self):
            # 供 curl/健康检查使用；不发送 body。
            path = urlsplit(self.path).path
            if path in ("/", "/module.md") or path in ASSETS:
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self.send_error(404, "Not found")

        def route(self):
            try:
                request = urlsplit(self.path)
            except ValueError:
                self.send_error(400, "Invalid URL")
                return

            path = request.path
            if path == "/":
                self.send_file(index_path, "text/html; charset=utf-8")
                return
            if path in ASSETS:
                filename, content_type = ASSETS[path]
                self.send_file(viewer_dir / filename, content_type)
                return
            if path == "/favicon.ico":
                self.send_body(204, "image/x-icon", b"")
                return
            if path == "/module.md":
                self.send_file(module_path, "text/plain; charset=utf-8")
                return
            if path == "/names":
                self.send_json(cache.names())
                return
            if path == "/data":
                self.handle_data(request.query)
                return
            if path == "/stats":
                snapshot = stats.snapshot()
                snapshot.update(cache.counts())
                snapshot["retention"] = cache.retention
                snapshot["version"] = VERSION
                self.send_json(snapshot)
                return
            if path == "/healthz":
                snapshot = stats.snapshot()
                healthy = bool(snapshot["receiver_alive"])
                self.send_json(
                    {
                        "ok": healthy,
                        "receiver_alive": snapshot["receiver_alive"],
                        "last_packet": snapshot["last_packet"],
                        "last_error": snapshot["last_error"],
                    },
                    status=200 if healthy else 503,
                )
                return
            self.send_error(404, "Not found")

        def handle_data(self, query_string):
            query = parse_qs(query_string, keep_blank_values=True)
            raw_names = query.get("names", [])
            # 兼容旧的 names=a,b；新客户端用重复 names 参数，支持名称里带逗号。
            if len(raw_names) > 1:
                names = [name for name in raw_names if name]
            else:
                names = [
                    name
                    for group in raw_names
                    for name in group.split(",")
                    if name
                ]
            # 去重并限制数量，避免异常查询拖垮服务。
            seen = set()
            unique_names = []
            for name in names:
                if name in seen:
                    continue
                seen.add(name)
                unique_names.append(name)
                if len(unique_names) >= MAX_NAMES_PER_QUERY:
                    break
            since = None
            if "since" in query:
                try:
                    since = finite_float(query["since"][-1])
                except (ValueError, OverflowError):
                    self.send_error(400, "Invalid since timestamp")
                    return
            self.send_json(cache.data(unique_names, since))

    return Handler


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="项目目录，可使用相对或绝对路径")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP/UDP 监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8765, help="HTTP 端口，默认 8765")
    parser.add_argument("--udp-port", type=int, default=8766, help="UDP 端口，默认 8766")
    parser.add_argument(
        "--retention",
        type=float,
        default=RETENTION_SECONDS,
        help="内存中保留的秒数，默认 30",
    )
    parser.add_argument("--verbose", action="store_true", help="打印访问日志和请求错误")
    parser.add_argument("--open", action="store_true", help="启动后尝试打开浏览器")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not math.isfinite(args.retention) or args.retention < 5:
        raise SystemExit("--retention 必须是大于等于 5 的有限秒数")
    project_dir = Path(args.project).expanduser().resolve()
    if not project_dir.is_dir():
        raise SystemExit("项目目录不存在：%s" % project_dir)
    if not (project_dir / "module.md").is_file():
        print("警告：%s 下没有 module.md，页面会提示无法读取。" % project_dir, file=sys.stderr)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(
            "警告：正在监听非回环地址 %s，请确认网络访问范围。" % args.host,
            file=sys.stderr,
        )

    cache = DataCache(retention=args.retention)
    stats = Stats()
    stop_event = threading.Event()

    udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        udp_socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    except OSError:
        pass
    try:
        udp_socket.bind((args.host, args.udp_port))
    except OSError as error:
        udp_socket.close()
        raise SystemExit("无法绑定 UDP %s:%s：%s" % (args.host, args.udp_port, error))
    udp_socket.settimeout(1.0)

    handler = make_handler(project_dir, cache, stats, verbose=args.verbose)
    try:
        http_server = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as error:
        udp_socket.close()
        raise SystemExit("无法绑定 HTTP %s:%s：%s" % (args.host, args.port, error))
    http_server.daemon_threads = True
    http_server.request_queue_size = 32

    receiver = threading.Thread(
        target=receive_udp,
        args=(udp_socket, cache, stats, stop_event),
        name="probe-udp-receiver",
        daemon=True,
    )
    receiver.start()

    url = "http://%s:%s/" % (args.host, http_server.server_address[1])
    print("项目：%s" % project_dir, flush=True)
    print("HTTP：%s" % url, flush=True)
    print(
        "UDP ：%s:%s（保留 %ss）"
        % (args.host, udp_socket.getsockname()[1], args.retention),
        flush=True,
    )
    if args.open:
        try:
            import webbrowser

            webbrowser.open(url)
        except Exception:
            pass

    previous_sigterm = None
    if hasattr(signal, "SIGTERM"):
        def _terminate(signum, frame):
            raise KeyboardInterrupt

        previous_sigterm = signal.signal(signal.SIGTERM, _terminate)
    try:
        http_server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        if previous_sigterm is not None:
            signal.signal(signal.SIGTERM, previous_sigterm)
        stop_event.set()
        try:
            udp_socket.close()
        except OSError:
            pass
        http_server.server_close()
        receiver.join(timeout=2.0)
        print("已停止。", flush=True)


if __name__ == "__main__":
    main()
