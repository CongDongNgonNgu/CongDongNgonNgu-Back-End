import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Actual complete-source candidate CI41377326090. Immutable code pins, never
// supplied by runtime manifest metadata. The original manifest is preserved
// under distribution-manifest.json when the runtime manifest is created.
export const MINIMAL_NATIVE_DISTRIBUTION = Object.freeze([
  {
    "file": "BUILDING.md",
    "bytes": 2316,
    "sha256": "a7c2921d7d953c8bfc2bb1ae846d63205387394c408b4b9f99eb00d586ee4733"
  },
  {
    "file": "SOURCE-MATERIALS.md",
    "bytes": 3018,
    "sha256": "36beba2db2e770be55228c1ff6c8e72ff03051ff697579e102327eeb4899b2c5"
  },
  {
    "file": "build/build.sh",
    "bytes": 3305,
    "sha256": "ffbcec79112bc6f19a6e565feac98fa862cd6a19a6a7579d858585e4ecc00f08"
  },
  {
    "file": "build/bundle.py",
    "bytes": 13502,
    "sha256": "4375e9cfab5a4228a575c1b80802f2d4f0716fef3f2bbab81204a63392c4ecc5"
  },
  {
    "file": "build/check-source.py",
    "bytes": 2763,
    "sha256": "ac599e837a725cee402ddbe7117b57b64d8e97e4fba162f0959337591d25016a"
  },
  {
    "file": "build/gcc-notice-source.json",
    "bytes": 651,
    "sha256": "0865ac9cb2279a8d6579cccaa302d389e89608e389105d8125f5049883e847f1"
  },
  {
    "file": "build/link-provenance.sh",
    "bytes": 3386,
    "sha256": "1ee4d1a2d8d290022ff691e7e92e2662c26cb0e31c25fa2f88e12885c58653cc"
  },
  {
    "file": "build/runtime-source-manifest.json",
    "bytes": 1903,
    "sha256": "f9ecb6c0c97375ab4e424d052f2211ef3c4dba2cb7e9d983e3ee8fd4fa4ac454"
  },
  {
    "file": "build/workflow.yml",
    "bytes": 11876,
    "sha256": "92c8b863677b05825cd85a931fc883f0baeaddf510cf42777bc89715b9a6bfd5"
  },
  {
    "file": "evidence/binutils.txt",
    "bytes": 281,
    "sha256": "c8a5239ca0e8268c178da2617843c3e92788711b1e1abafa232616bd487e729c"
  },
  {
    "file": "evidence/builder-libc.txt",
    "bytes": 11,
    "sha256": "d413ead7ce9065771e2e436981fabd86519efcf109a71c81ffa37dd397fa825b"
  },
  {
    "file": "evidence/builder-os.txt",
    "bytes": 267,
    "sha256": "59a77b5f2666d9c85c489bd1911a6eebbd91ef22fe48b90a3b75f1b21f3844d4"
  },
  {
    "file": "evidence/compiler.txt",
    "bytes": 219,
    "sha256": "23ffd2bf366750bda8699e8936206a483d3c4af464e09ea8990e212c44ae51c3"
  },
  {
    "file": "evidence/config.h",
    "bytes": 24609,
    "sha256": "99970b0b636ab0ad787c8b5e3b2c86e303d0cffe8513ce80eaa80585e486397e"
  },
  {
    "file": "evidence/config.mak",
    "bytes": 88982,
    "sha256": "db47b38f95aae2526c65ab77587b95efdf997f54a831cd9a510c19239a6218c0"
  },
  {
    "file": "evidence/config_components.h",
    "bytes": 75690,
    "sha256": "2d148bc791cb57f17db86d5bcd8011956a10abd91cdfec3b8fbdca3f3f1ebfe5"
  },
  {
    "file": "evidence/configure-args.txt",
    "bytes": 643,
    "sha256": "4e75f6af8f14055bc6e291e0712315c5a1db67e91a9220f7bafef297d206b07b"
  },
  {
    "file": "evidence/ffmpeg.dynamic.txt",
    "bytes": 1444,
    "sha256": "66c9e6effc4a7df26bfd3bb9d82a7039f5700db80ff275e2284c65f6b479ea51"
  },
  {
    "file": "evidence/ffmpeg.link-map.txt",
    "bytes": 632653,
    "sha256": "0f42b2e32b188b314655336565395de150b98ff53bc5b0af52e4bd96705919cd"
  },
  {
    "file": "evidence/ffmpeg.link-trace.txt",
    "bytes": 4143,
    "sha256": "60b57f2be917f3a872da1189321146fd829528c9980fe0aa8b5546834dcefc6d"
  },
  {
    "file": "evidence/ffmpeg.versions.txt",
    "bytes": 4245,
    "sha256": "8c9bce221ecb1a77bb8091c3749da5ee5e5800baf964f4309a8c812f56abd103"
  },
  {
    "file": "evidence/ffprobe.dynamic.txt",
    "bytes": 1444,
    "sha256": "2e44a6b912c6555302c1ef7f370bbf570459456347ccf0712e7ecfcbaabea03a"
  },
  {
    "file": "evidence/ffprobe.link-map.txt",
    "bytes": 601052,
    "sha256": "71a0f8cea7256cad7882318673245deb735b7f71588ffff9154bc9f98a5791df"
  },
  {
    "file": "evidence/ffprobe.link-trace.txt",
    "bytes": 3428,
    "sha256": "2d865ff5d9a2199cdd11db2629141cb19a773098bc8624ec25602e7d5e4302ad"
  },
  {
    "file": "evidence/ffprobe.versions.txt",
    "bytes": 3990,
    "sha256": "a516f623183ddd9d6e189bf901bd3dbf9f34e0a80635402521958a5068883bf8"
  },
  {
    "file": "evidence/gcc-runtime-locations.txt",
    "bytes": 165,
    "sha256": "feea5a0cce1890e9429d29909f6a4ee8d81ca9b9a4a76831fb0f9dcb56d24008"
  },
  {
    "file": "evidence/relink-binaries.sha256",
    "bytes": 314,
    "sha256": "69d6868b15a5a29d71952a8fb76ae949e70b012f95c6d0fdd4f27f0b8dba262e"
  },
  {
    "file": "evidence/runtime-input-paths.txt",
    "bytes": 732,
    "sha256": "68b1c649d7a7b2302f5ef51bee46b58a6bb0e6c26b0fce28336e438da14fee45"
  },
  {
    "file": "evidence/runtime-inputs.tsv",
    "bytes": 2592,
    "sha256": "72dfa434e550f9b0898de89d12fc402e76e17230e4286551a05a10160260b41c"
  },
  {
    "file": "evidence/system-libc-copyright.txt",
    "bytes": 25467,
    "sha256": "40c7e1f2118531f038ca22999bd976901254e1bc5cd1b0f0211bdd064c599987"
  },
  {
    "file": "evidence/system-package-versions.txt",
    "bytes": 104,
    "sha256": "157f6dfac159ec5e9493f398b194679abb5d816fc88a8ecc4613519d8ebb688c"
  },
  {
    "file": "distribution-manifest.json",
    "bytes": 7243,
    "sha256": "5dbafdeebb0b57b8cc3e659338573d2e1eaf0e3df43f16726d2e47260bf00453"
  },
  {
    "file": "notices/COPYING.GPLv2",
    "bytes": 18092,
    "sha256": "8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643"
  },
  {
    "file": "notices/COPYING.GPLv3",
    "bytes": 35147,
    "sha256": "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"
  },
  {
    "file": "notices/COPYING.LGPLv2.1",
    "bytes": 26517,
    "sha256": "246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30"
  },
  {
    "file": "notices/COPYING.LGPLv3",
    "bytes": 7651,
    "sha256": "da7eabb7bafdf7d3ae5e9f223aa5bdc1eece45ac569dc21b3b037520b4464768"
  },
  {
    "file": "notices/CREDITS",
    "bytes": 277,
    "sha256": "28ecc96d495fa5ad48c76739a8f8d2c8980548d7a171585a6eb3f27a9ac8e4a2"
  },
  {
    "file": "notices/LICENSE.md",
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
