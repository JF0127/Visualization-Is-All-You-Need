import json
import socket
import sys
import time
import unittest
from pathlib import Path

DEMO = Path(__file__).resolve().parents[1] / "examples" / "demo"
if str(DEMO) not in sys.path:
    sys.path.insert(0, str(DEMO))

import common  # noqa: E402
import controller  # noqa: E402
import plant  # noqa: E402
import sensor  # noqa: E402


class DemoHelpersTest(unittest.TestCase):
    def test_wait_for_next_tick(self):
        now = time.monotonic()
        later = common.wait_for_next_tick(now - 10, 0.01)
        self.assertGreaterEqual(later, time.monotonic() - 0.01)

    def test_recv_latest_parses_only_last_packet(self):
        receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        receiver.bind(("127.0.0.1", 0))
        receiver.setblocking(False)
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sender.sendto(json.dumps({"n": 1}).encode(), receiver.getsockname())
            sender.sendto(json.dumps({"n": 2}).encode(), receiver.getsockname())
            time.sleep(0.02)
            self.assertEqual(common.recv_latest(receiver), {"n": 2})
            sender.sendto(b"broken", receiver.getsockname())
            time.sleep(0.02)
            self.assertIsNone(common.recv_latest(receiver))
        finally:
            sender.close()
            receiver.close()

    def test_send_json_is_resilient(self):
        receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        receiver.bind(("127.0.0.1", 0))
        receiver.settimeout(1)
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.assertTrue(common.send_json(sender, receiver.getsockname(), {"a": 1}))
            self.assertEqual(json.loads(receiver.recvfrom(65535)[0]), {"a": 1})
            self.assertFalse(common.send_json(sender, receiver.getsockname(), {"a": object()}))
        finally:
            sender.close()
            receiver.close()


class DemoAlgorithmsTest(unittest.TestCase):
    def test_moving_average(self):
        self.assertEqual(controller.moving_average([]), 0.0)
        self.assertEqual(controller.moving_average([1, 2, 3]), 2.0)

    def test_pid_step(self):
        state = {"integral": 0.0, "prev_error": None}
        first = controller.pid_step(state, 1.0, 0.1, 2.0, 0.5, 0.1)
        second = controller.pid_step(state, 2.0, 0.1, 2.0, 0.5, 0.1)
        self.assertGreater(second, first)

    def test_motor_step(self):
        position, velocity = plant.motor_step(0.0, 0.0, 1.0, 0.01, 0.2)
        self.assertGreater(velocity, 0.0)
        self.assertGreater(position, 0.0)

    def test_sensor_signal(self):
        self.assertAlmostEqual(sensor.generate_target(0.0, 1.0, 0.2), 0.0)
        self.assertAlmostEqual(sensor.generate_target(0.0, 2.0, 0.2), 0.0)

    def test_sensor_noise_is_finite(self):
        value = sensor.add_noise(1.0, 0.0)
        self.assertEqual(value, 1.0)


if __name__ == "__main__":
    unittest.main()
