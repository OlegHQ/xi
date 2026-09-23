#!/usr/bin/env python3
"""Write reproducible Xi release archives with Python's standard library."""

import gzip
from pathlib import Path
import sys
import tarfile
import zipfile


source, destination = map(Path, sys.argv[1:3])
files = sorted(path for path in source.rglob("*") if path.is_file())

if destination.suffix == ".zip":
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            name = path.relative_to(source).as_posix()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if name == "xi.exe" else 0o644) << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
else:
    with destination.open("wb") as output, gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for path in files:
                name = path.relative_to(source).as_posix()
                info = archive.gettarinfo(path, arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = 0
                info.mode = 0o755 if name == "xi" else 0o644
                with path.open("rb") as content:
                    archive.addfile(info, content)
