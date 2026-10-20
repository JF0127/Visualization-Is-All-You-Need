"""接收 UDP 打点数据，并通过本地 HTTP 服务提供页面、模块说明和缓存数据。"""

import argparse
import json
import math
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


RETENTION_SECONDS = 30.0


class DataCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._points = {}
        self._latest = {}

    def _prune_locked(self, now):
        cutoff = now - RETENTION_SECONDS
        for name, points in list(self._points.items()):
            # UDP 包可能乱序，不能只移除列表开头的过期数据。
            recent = [point for point in points if point[0] >= cutoff]
            if recent:
                self._points[name] = recent
            else:
                del self._points[name]

    def add(self, name, timestamp, value):
        with self._lock:
            self._points.setdefault(name, []).append([timestamp, value])
            self._latest[name] = timestamp
            self._prune_locked(time.time())

    def prune(self):
        with self._lock:
            self._prune_locked(time.time())

    def data(self, names, since):
        with self._lock:
            self._prune_locked(time.time())
            return {
                name: [
                    point
                    for point in self._points.get(name, [])
                    if since is None or point[0] > since
                ]
                for name in names
            }

    def names(self):
        with self._lock:
            self._prune_locked(time.time())
            # 数据过期后仍保留最近收到的时间戳，供页面判断是否停止产出。
            return dict(self._latest)


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Expected a finite number")
    return number


def reject_json_constant(value):
    raise ValueError("Invalid JSON constant: " + value)


def receive_udp(udp_socket, cache, stop_event):
    while not stop_event.is_set():
        try:
            packet, _ = udp_socket.recvfrom(65535)
        except socket.timeout:
            cache.prune()
            continue
        except OSError:
            return

        try:
            message = json.loads(
                packet.decode("utf-8"),
                parse_float=finite_float,
                parse_constant=reject_json_constant,
            )
            if not isinstance(message, dict):
                continue
            name = message.get("name")
            timestamp = message.get("t")
            if not isinstance(name, str) or "value" not in message:
                continue
            if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
                continue
            timestamp = finite_float(timestamp)
        except (ValueError, TypeError, OverflowError, RecursionError):
            continue

        cache.add(name, timestamp, message["value"])


def make_handler(project_dir, cache):
    index_path = Path(__file__).resolve().parent / "index.html"
    module_path = project_dir / "module.md"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def end_headers(self):
            # 包括错误响应在内，统一禁止浏览器和代理缓存。
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            super().end_headers()

        def send_body(self, status, content_type, body):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def send_json(self, value):
            body = json.dumps(value, allow_nan=False, separators=(",", ":")).encode("utf-8")
            self.send_body(200, "application/json; charset=utf-8", body)

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
                request = urlsplit(self.path)
            except ValueError:
                self.send_error(400, "Invalid URL")
                return

            if request.path == "/":
                self.send_file(index_path, "text/html; charset=utf-8")
            elif request.path == "/module.md":
                self.send_file(module_path, "text/plain; charset=utf-8")
            elif request.path == "/names":
                self.send_json(cache.names())
            elif request.path == "/data":
                query = parse_qs(request.query, keep_blank_values=True)
                names = [
                    name
                    for group in query.get("names", [])
                    for name in group.split(",")
                    if name
                ]
                since = None
                if "since" in query:
                    try:
                        since = finite_float(query["since"][-1])
                    except (ValueError, OverflowError):
                        self.send_error(400, "Invalid since timestamp")
                        return
                self.send_json(cache.data(names, since))
            else:
                self.send_error(404, "Not found")

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="项目目录，可使用相对或绝对路径")
    parser.add_argument("--port", type=int, default=8765, help="HTTP 端口，默认 8765")
    parser.add_argument("--udp-port", type=int, default=8766, help="UDP 端口，默认 8766")
    args = parser.parse_args()

    project_dir = Path(args.project).expanduser().resolve()
    cache = DataCache()
    stop_event = threading.Event()

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp_socket:
        udp_socket.bind(("127.0.0.1", args.udp_port))
        udp_socket.settimeout(1.0)
        handler = make_handler(project_dir, cache)
        with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as http_server:
            receiver = threading.Thread(
                target=receive_udp,
                args=(udp_socket, cache, stop_event),
                name="probe-udp-receiver",
                daemon=True,
            )
            receiver.start()
            try:
                print("http://127.0.0.1:{}/".format(http_server.server_address[1]), flush=True)
                http_server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                stop_event.set()
                receiver.join()


if __name__ == "__main__":
    main()
