"""打点库：把运行中的数值通过 UDP 发送给本地监测端。"""

from .probe import probe, stats

__all__ = ["probe", "stats"]
