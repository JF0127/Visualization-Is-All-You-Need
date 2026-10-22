import json
import socket
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from viewer import server


class DataCacheTest(unittest.TestCase):
    def test_add_data_and_since(self):
        now = time.time()
        cache = server.DataCache(retention=30)
        accepted, skewed = cache.add("a", now, 1.5, received_at=now)
        self.assertTrue(accepted)
        self.assertFalse(skewed)
        cache.add("b", now, 2.5, received_at=now)
        result = cache.data(["a", "b"], None)
        self.assertEqual(result["a"][0][1], 1.5)
        self.assertEqual(result["b"][0][1], 2.5)
        result = cache.data(["a"], now + 1)
        self.assertEqual(result["a"], [])

    def test_future_and_past_timestamps_are_normalized(self):
        now = time.time()
        cache = server.DataCache()
        _, future_skewed = cache.add("future", now + 120, 1, received_at=now)
        _, past_skewed = cache.add("past", now - 120, 2, received_at=now)
        self.assertTrue(future_skewed)
        self.assertTrue(past_skewed)
        values = cache.data(["future", "past"], None)
        self.assertAlmostEqual(values["future"][0][0], now, places=2)
        self.assertAlmostEqual(values["past"][0][0], now, places=2)

    def test_out_of_order_latest_uses_maximum(self):
        now = time.time()
        cache = server.DataCache()
        cache.add("a", now, 2, received_at=now)
        cache.add("a", now - 0.1, 1, received_at=now + 0.05)
        self.assertAlmostEqual(cache.names()["a"], now, places=3)
        points = cache.data(["a"], None)["a"]
        self.assertEqual([point[1] for point in points], [2, 1])

    def test_periodic_prune_removes_expired_points(self):
        now = time.time()
        cache = server.DataCache(retention=30)
        cache.add("a", now, 1, received_at=now)
        cache.add("b", now + 31, 2, received_at=now + 31)
        with mock.patch("viewer.server.time.time", return_value=now + 31):
            result = cache.data(["a", "b"], None)
        self.assertEqual(result["a"], [])
        self.assertEqual(len(result["b"]), 1)

    def test_latest_names_expire(self):
        now = time.time()
        cache = server.DataCache()
        cache.add("a", now, 1, received_at=now)
        with mock.patch(
            "viewer.server.time.time",
            return_value=now + server.LATEST_TTL_SECONDS + 1,
        ):
            self.assertEqual(cache.names(), {})

    def test_points_per_name_are_capped(self):
        now = time.time()
        cache = server.DataCache()
        with mock.patch.object(server, "MAX_POINTS_PER_NAME", 10):
            for index in range(25):
                cache.add("a", now + index * 0.001, index, received_at=now + index * 0.001)
            cache.prune()
            points = cache.data(["a"], None)["a"]
        self.assertEqual(len(points), 10)
        self.assertEqual(points[-1][1], 24)

    def test_retention_property_and_counts(self):
        now = time.time()
        cache = server.DataCache(retention=12)
        cache.add("a", now, 1, received_at=now)
        self.assertEqual(cache.retention, 12)
        self.assertEqual(cache.counts()["names"], 1)
        self.assertEqual(cache.counts()["points"], 1)


class ParsingTest(unittest.TestCase):
    def test_finite_float(self):
        self.assertEqual(server.finite_float("1.5"), 1.5)
        for value in ("nan", "inf", "-inf", "1e999"):
            with self.assertRaises(ValueError):
                server.finite_float(value)

    def test_reject_json_constant(self):
        with self.assertRaises(ValueError):
            server.reject_json_constant("NaN")


class EndpointTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        project = Path(self.temp.name)
        (project / "module.md").write_text("# test\n", encoding="utf-8")
        self.cache = server.DataCache()
        now = time.time()
        self.cache.add("a", now, 1, received_at=now)
        self.cache.add("b", now, 2, received_at=now)
        self.cache.add("a,b", now, 3, received_at=now)
        self.stats = server.Stats()
        self.stats.set_receiver(True)
        self.handler = server.make_handler(project, self.cache, self.stats)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self.handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, method, path, connection=None):
        owns_connection = connection is None
        connection = connection or HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            body = response.read()
            return response, body
        finally:
            if owns_connection:
                connection.close()


    def test_static_and_module(self):
        response, body = self.request("GET", "/")
        self.assertEqual(response.status, 200)
        self.assertIn(b"/app.js", body)
        self.assertIn("text/html", response.getheader("Content-Type"))
        self.assertIn("unsafe-inline", response.getheader("Content-Security-Policy"))
        response, body = self.request("GET", "/app.js")
        self.assertEqual(response.status, 200)
        self.assertIn("javascript", response.getheader("Content-Type"))
        response, _ = self.request("GET", "/theme-init.js")
        self.assertEqual(response.status, 200)
        response, _ = self.request("GET", "/app.css")
        self.assertEqual(response.status, 200)
        response, body = self.request("GET", "/module.md")
        self.assertEqual(body, b"# test\n")

    def test_data_legacy_comma_and_repeated_names(self):
        response, body = self.request("GET", "/data?names=a,b")
        payload = json.loads(body)
        self.assertEqual(set(payload), {"a", "b"})
        response, body = self.request("GET", "/data?names=a%2Cb&names=a")
        payload = json.loads(body)
        self.assertEqual(set(payload), {"a,b", "a"})

    def test_since_and_invalid_since(self):
        response, body = self.request("GET", "/data?names=a&since=9999999999")
        self.assertEqual(json.loads(body)["a"], [])
        response, _ = self.request("GET", "/data?names=a&since=nan")
        self.assertEqual(response.status, 400)

    def test_stats_and_health(self):
        response, body = self.request("GET", "/stats")
        payload = json.loads(body)
        self.assertTrue(payload["receiver_alive"])
        self.assertEqual(payload["version"], server.VERSION)
        self.assertIn("points", payload)
        response, body = self.request("GET", "/healthz")
        self.assertEqual(response.status, 200)
        self.stats.set_receiver(False, "test")
        response, body = self.request("GET", "/healthz")
        self.assertEqual(response.status, 503)
        self.assertFalse(json.loads(body)["ok"])

    def test_keep_alive_and_head(self):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=3)
        first, body = self.request("GET", "/names", connection)
        self.assertEqual(first.status, 200)
        second, body = self.request("GET", "/names", connection)
        self.assertEqual(second.status, 200)
        connection.close()
        response, body = self.request("HEAD", "/app.js")
        self.assertEqual(response.status, 200)
        self.assertEqual(body, b"")

    def test_missing_route(self):
        response, _ = self.request("GET", "/nope")
        self.assertEqual(response.status, 404)


class UdpReceiverTest(unittest.TestCase):
    def test_receiver_accepts_valid_and_rejects_invalid(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("127.0.0.1", 0))
        sock.settimeout(0.1)
        cache = server.DataCache()
        stats = server.Stats()
        stop = threading.Event()
        thread = threading.Thread(target=server.receive_udp, args=(sock, cache, stats, stop), daemon=True)
        thread.start()
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        port = sock.getsockname()[1]
        now = time.time()
        sender.sendto(
            json.dumps({"name": "x", "t": now, "value": 1.25}).encode("utf-8"),
            ("127.0.0.1", port),
        )
        for _ in range(30):
            if "x" in cache.names():
                break
            time.sleep(0.02)
        sender.sendto(b"not-json", ("127.0.0.1", port))
        for _ in range(30):
            if stats.snapshot()["invalid"] >= 1:
                break
            time.sleep(0.02)
        self.assertIn("x", cache.names())
        self.assertGreaterEqual(stats.snapshot()["invalid"], 1)
        stop.set()
        sender.close()
        sock.close()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())


class MathHelpersTest(unittest.TestCase):
    def test_stats_snapshot(self):
        stats = server.Stats()
        stats.set_receiver(True)
        stats.received(10)
        stats.accepted(True)
        snapshot = stats.snapshot()
        self.assertTrue(snapshot["receiver_alive"])
        self.assertEqual(snapshot["packets"], 1)
        self.assertEqual(snapshot["skewed"], 1)


if __name__ == "__main__":
    unittest.main()
