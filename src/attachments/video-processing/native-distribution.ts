import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Actual complete-source SIMD candidate CI42555671199. Immutable code pins, never
// supplied by runtime manifest metadata. The original manifest is preserved
// under distribution-manifest.json when the runtime manifest is created.
export const MINIMAL_NATIVE_DISTRIBUTION = Object.freeze([
  {
    "file": "BUILDING.md",
    "bytes": 1110,
    "sha256": "092be1680f71f191b4351f86dd22391c2a06c5325893fd717896a69c572c9751"
  },
  {
    "file": "SOURCE-MATERIALS.md",
    "bytes": 3018,
    "sha256": "36beba2db2e770be55228c1ff6c8e72ff03051ff697579e102327eeb4899b2c5"
  },
  {
    "file": "build/gcc-notice-source.json",
    "bytes": 651,
    "sha256": "0865ac9cb2279a8d6579cccaa302d389e89608e389105d8125f5049883e847f1"
  },
  {
    "file": "build/native-build-inputs.json",
    "bytes": 167788,
    "sha256": "97d71d605cb3af2b41565a1784143332fa3576a3517c459968a38d280c432a32"
  },
  {
    "file": "build/runtime-source-manifest.json",
    "bytes": 1903,
    "sha256": "f9ecb6c0c97375ab4e424d052f2211ef3c4dba2cb7e9d983e3ee8fd4fa4ac454"
  },
  {
    "file": "evidence/observations.json",
    "bytes": 3439560,
    "sha256": "45a6054c1604d20c2c1350c6cd93d04c7860dbc349d64c311ba85bb2e2bd48de"
  },
  {
    "file": "distribution-manifest.json",
    "bytes": 3433,
    "sha256": "51815496f1994d30b6d712bc79e3aba94ab2c10b80829821fadfce0524cb6cf3"
  },
  {
    "file": "notices/ffmpeg/COPYING.GPLv2",
    "bytes": 18092,
    "sha256": "8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643"
  },
  {
    "file": "notices/ffmpeg/COPYING.GPLv3",
    "bytes": 35147,
    "sha256": "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"
  },
  {
    "file": "notices/ffmpeg/COPYING.LGPLv2.1",
    "bytes": 26517,
    "sha256": "246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30"
  },
  {
    "file": "notices/ffmpeg/COPYING.LGPLv3",
    "bytes": 7651,
    "sha256": "da7eabb7bafdf7d3ae5e9f223aa5bdc1eece45ac569dc21b3b037520b4464768"
  },
  {
    "file": "notices/ffmpeg/CREDITS",
    "bytes": 277,
    "sha256": "28ecc96d495fa5ad48c76739a8f8d2c8980548d7a171585a6eb3f27a9ac8e4a2"
  },
  {
    "file": "notices/ffmpeg/LICENSE.md",
    "bytes": 4346,
    "sha256": "2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af"
  },
  {
    "file": "notices/gcc/COPYING.RUNTIME",
    "bytes": 3324,
    "sha256": "9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74"
  },
  {
    "file": "notices/gcc/COPYING3",
    "bytes": 35147,
    "sha256": "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"
  },
  {
    "file": "notices/glibc/COPYING.LIB",
    "bytes": 26530,
    "sha256": "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551"
  },
  {
    "file": "notices/nasm/AUTHORS",
    "bytes": 3060,
    "sha256": "8a7bd0cc6c517a220265548bf2ecf62fe89bf682b6a9938afb7521008679149e"
  },
  {
    "file": "notices/nasm/LICENSE",
    "bytes": 1521,
    "sha256": "1563996c52e220e15ef2418e67d39488255aa8c28c89e617074d3afe3ee329e0"
  },
  {
    "file": "source/ffmpeg.tar.gz",
    "bytes": 17330151,
    "sha256": "cd6175d64b7f152469d48ceffa0dcb3bf36bb3bcae42aece46570d48563cdb85"
  },
  {
    "file": "source/gcc/Makefile.in",
    "bytes": 39964,
    "sha256": "c215d843ba933a8e63f4ae4f9848a58382bf53b15371970b4ff6a9623dea520c"
  },
  {
    "file": "source/gcc/crtstuff.c",
    "bytes": 26399,
    "sha256": "5859380c2242ce108b323fe216847df6f2be052fa98ca56eb6284daacda3befd"
  },
  {
    "file": "source/gcc/libgcc2.c",
    "bytes": 74797,
    "sha256": "0bf1fa3e4b9be1fd45a47682cb119d4f8fda17f02398d157a189d49c6f2d2919"
  },
  {
    "file": "source/glibc/glibc_2.36-9+deb12u10.debian.tar.xz",
    "bytes": 902612,
    "sha256": "6ad2f9dfc88bec54f0bacab04d14f71dbd3eea0cedd91a23a8911fd09847fbc9"
  },
  {
    "file": "source/glibc/glibc_2.36-9+deb12u10.dsc",
    "bytes": 9765,
    "sha256": "ba6d00fde9d2f11af56861674dc87c5dc5a7c3f2c1c0a7dd4d63d76639e6ec98"
  },
  {
    "file": "source/glibc/glibc_2.36.orig.tar.xz",
    "bytes": 19363988,
    "sha256": "a543c02070d46ccaf866957efd13f10c924daa74c86a90a0254db09a92a708ee"
  },
  {
    "file": "source/nasm.tar.gz",
    "bytes": 1688160,
    "sha256": "5bc940dd8a4245686976a8f7e96ba9340a0915f2d5b88356874890e207bdb581"
  }
]);

export async function verifyMinimalNativeDistribution(directory: string): Promise<void> {
  for (const pin of MINIMAL_NATIVE_DISTRIBUTION) {
    const file=join(directory,pin.file), info=await lstat(file);
    if (!info.isFile() || info.size!==pin.bytes) throw Error('PROCESSING_UNAVAILABLE');
    const hash=createHash('sha256'); let bytes=0;
    for await (const chunk of createReadStream(file)) {
      bytes+=chunk.length;
      if (bytes>pin.bytes) throw Error('PROCESSING_UNAVAILABLE');
      hash.update(chunk);
    }
    if (bytes!==pin.bytes || hash.digest('hex')!==pin.sha256) throw Error('PROCESSING_UNAVAILABLE');
  }
}
