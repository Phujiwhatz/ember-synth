#!/usr/bin/env python3
"""Pack rendered WAVs into library.zip with entries exactly <Category>/<Name>.wav."""
import os
import sys
import zipfile

CATEGORIES = ["Kicks", "Snares", "Claps", "Hats", "Cymbals", "Toms", "Percussion", "FX"]


def main(src, dst):
    count = 0
    tmp = dst + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for cat in CATEGORIES:
            d = os.path.join(src, cat)
            if not os.path.isdir(d):
                sys.exit("missing category folder: " + cat)
            for name in sorted(os.listdir(d)):
                if name.lower().endswith(".wav"):
                    # fixed timestamp so rebuilds are byte-identical
                    info = zipfile.ZipInfo(cat + "/" + name, date_time=(2026, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with open(os.path.join(d, name), "rb") as f:
                        z.writestr(info, f.read())
                    count += 1
    os.replace(tmp, dst)
    print("packed %d sounds -> %s (%.2f MB)" % (count, dst, os.path.getsize(dst) / 1e6))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
