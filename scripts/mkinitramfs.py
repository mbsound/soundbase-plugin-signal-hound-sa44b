#!/usr/bin/env python3
"""Write a gzip-compressed newc cpio archive of a directory, every entry owned
by root, for use as a Linux initramfs. Used by scripts/build-guest.sh; it
replaces `find | cpio -o -H newc | gzip`, whose ownership handling differs
between bsdcpio and GNU cpio.

    mkinitramfs.py <dir> <out.img>
"""
import gzip
import os
import stat
import sys


def entry(name, st, data=b"", ino=0):
    mode = st.st_mode
    nlink = 2 if stat.S_ISDIR(mode) else 1
    fields = [
        0x070701, ino, mode, 0, 0, nlink, 0,  # magic ino mode uid gid nlink mtime (fixed: reproducible)
        len(data), 0, 0, 0, 0, len(name) + 1, 0,
    ]
    hdr = b"070701" + b"".join(b"%08X" % f for f in fields[1:])
    out = hdr + name.encode() + b"\0"
    out += b"\0" * ((4 - len(out) % 4) % 4)
    out += data
    out += b"\0" * ((4 - len(data) % 4) % 4)
    return out


def main(root, dest):
    chunks = []
    ino = 1
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for n in sorted(dirnames + filenames):
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, root)
            st = os.lstat(full)
            ino += 1
            if stat.S_ISLNK(st.st_mode):
                chunks.append(entry(rel, st, os.readlink(full).encode(), ino))
            elif stat.S_ISDIR(st.st_mode):
                chunks.append(entry(rel, st, b"", ino))
            elif stat.S_ISREG(st.st_mode):
                with open(full, "rb") as f:
                    chunks.append(entry(rel, st, f.read(), ino))
    chunks.append(entry("TRAILER!!!", os.stat_result((0,) * 10), b"", 0))
    raw = b"".join(chunks)
    with open(dest, "wb") as f:
        f.write(gzip.compress(raw, 9, mtime=0))
    print(f"[mkinitramfs] {dest}: {len(raw)} bytes raw, {os.path.getsize(dest)} compressed")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
