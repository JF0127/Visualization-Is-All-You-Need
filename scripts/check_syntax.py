#!/usr/bin/env python3
"""编译检查所有 Python 源文件，不写 __pycache__。"""

from pathlib import Path


def main():
    files = []
    for folder in ("viewer", "probe", "tests"):
        files.extend(sorted(Path(folder).glob("*.py")))
    files.extend(sorted(Path("examples/demo").glob("*.py")))
    for path in files:
        compile(path.read_text(encoding="utf-8"), str(path), "exec")
    print("Python syntax OK (%d files)" % len(files))


if __name__ == "__main__":
    main()
