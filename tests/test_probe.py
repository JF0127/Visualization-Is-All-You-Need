import json
import math
import unittest
from decimal import Decimal
from unittest import mock

import importlib

probe_module = importlib.import_module("probe.probe")


class CleanValueTest(unittest.TestCase):
    def test_non_finite_becomes_none(self):
        self.assertIsNone(probe_module._clean(float("nan")))
        self.assertIsNone(probe_module._clean(float("inf")))
        self.assertIsNone(probe_module._clean(float("-inf")))

    def test_common_numeric_types(self):
        self.assertEqual(probe_module._clean(Decimal("1.25")), 1.25)
        self.assertEqual(probe_module._clean(b"abc"), "abc")
        self.assertEqual(probe_module._clean((1, 2)), [1, 2])
        self.assertEqual(probe_module._clean({"a": 1}), {"a": 1})

    def test_custom_numeric_objects(self):
        class Item:
            def item(self):
                return 3.5

        class Floatable:
            def __float__(self):
                return 4.5

        self.assertEqual(probe_module._clean(Item()), 3.5)
        self.assertEqual(probe_module._clean(Floatable()), 4.5)

    def test_encode_normalizes_nan(self):
        data = probe_module._encode("x", [1, float("nan")], 10.0)
        payload = json.loads(data)
        self.assertEqual(payload["value"], [1, None])
        self.assertEqual(payload["name"], "x")
        self.assertEqual(payload["t"], 10.0)


class ProbeSendTest(unittest.TestCase):
    def test_empty_name_is_rejected(self):
        self.assertFalse(probe_module.probe("", 1))

    def test_send_uses_fake_socket(self):
        class FakeSocket:
            def __init__(self):
                self.payloads = []

            def sendto(self, data, destination):
                self.payloads.append((destination, data))
                return len(data)

        fake = FakeSocket()
        with mock.patch.object(probe_module, "_socket", fake):
            self.assertTrue(probe_module.probe("x", [1, float("nan"), Decimal("2.5")]))
        payload = json.loads(fake.payloads[0][1])
        self.assertEqual(payload["value"], [1, None, 2.5])

    def test_stats_shape(self):
        stats = probe_module.stats()
        self.assertIn("sent", stats)
        self.assertIn("dropped", stats)


if __name__ == "__main__":
    unittest.main()
