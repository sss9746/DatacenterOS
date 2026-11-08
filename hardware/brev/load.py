#!/usr/bin/env python3
"""Bounded GPU load for the DataCenterOS real-GPU demo (track G / F-NV2).

Runs a torch matmul loop on cuda so nvidia-smi temperature and power visibly rise,
then exits. It only does compute: it never changes power limits, clocks or any GPU setting.

    python3 load.py               # 60 s (default)
    python3 load.py --seconds 90  # hard max 120 s
"""
import argparse
import sys
import time

DEFAULT_SECONDS = 60
MAX_SECONDS = 120
MATRIX_N = 8192


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seconds", type=float, default=DEFAULT_SECONDS, help=f"duration (max {MAX_SECONDS})")
    args = parser.parse_args()
    seconds = max(1.0, min(args.seconds, MAX_SECONDS))
    if seconds != args.seconds:
        print(f"[load] clamped --seconds {args.seconds} -> {seconds:.0f} (allowed 1..{MAX_SECONDS})")

    try:
        import torch
    except ImportError:
        print("[load] torch is not installed. On the Brev box run:  pip install torch", file=sys.stderr)
        return 2
    if not torch.cuda.is_available():
        print("[load] torch sees no CUDA device (check nvidia-smi / the torch CUDA build)", file=sys.stderr)
        return 3

    dev = torch.device("cuda:0")
    dtype = torch.float16  # tensor cores on T4/L4/A10 -> highest power draw
    print(f"[load] {torch.cuda.get_device_name(dev)}: {MATRIX_N}x{MATRIX_N} fp16 matmul for {seconds:.0f}s")
    a = torch.randn(MATRIX_N, MATRIX_N, device=dev, dtype=dtype)
    b = torch.randn(MATRIX_N, MATRIX_N, device=dev, dtype=dtype)

    start = time.monotonic()
    deadline = start + seconds
    next_report = start + 5
    iters = 0
    try:
        while time.monotonic() < deadline:
            for _ in range(10):
                torch.matmul(a, b)
            torch.cuda.synchronize()
            iters += 10
            now = time.monotonic()
            if now >= next_report:
                tflops = 2 * MATRIX_N**3 * iters / (now - start) / 1e12
                print(f"[load] {now - start:5.0f}s  {tflops:6.1f} TFLOP/s")
                next_report += 5
    except KeyboardInterrupt:
        print("[load] interrupted")
    finally:
        del a, b
        torch.cuda.empty_cache()
    print(f"[load] done after {time.monotonic() - start:.0f}s; GPU should cool down now")
    return 0


if __name__ == "__main__":
    sys.exit(main())
