#!/usr/bin/env python3
"""Linux-only atomic exchange. No fallback that removes/replaces real directories."""
import ctypes
import os
import sys

if sys.platform != 'linux' or len(sys.argv) != 3:
    raise SystemExit('Linux renameat2 requires exactly two paths')
a, b = map(os.path.abspath, sys.argv[1:])
if a == b or os.path.dirname(a) != os.path.dirname(b):
    raise SystemExit('Exchange requires distinct sibling paths')
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
if renameat2(-100, os.fsencode(a), -100, os.fsencode(b), 2) != 0:
    raise SystemExit('Atomic exchange failed, errno=' + str(ctypes.get_errno()))
