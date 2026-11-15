"""Regenerate independent tar, gzip, and zip fixtures using Python's standard library."""

import gzip
import io
from pathlib import Path
import tarfile
import zipfile

ROOT = Path(__file__).parent
SKILL = b"---\nname: demo\ndescription: Download fixture\n---\nDownloaded skill.\n"
FILES = {
    "bundle/demo/SKILL.md": SKILL,
    "bundle/demo/run.sh": b"#!/bin/sh\necho demo\n",
    "bundle/demo/docs/guide.md": b"Fixture guide.\n",
}


def tar_archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, content in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o755 if name.endswith(".sh") else 0o644
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def zip_archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, content in entries.items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            mode = 0o100755 if name.endswith(".sh") else 0o100644
            info.external_attr = mode << 16
            archive.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED)
    return output.getvalue()


(ROOT / "skill.txt").write_bytes(SKILL)
(ROOT / "skill.tar").write_bytes(tar_archive(FILES))
(ROOT / "skill.tar.gz").write_bytes(gzip.compress(tar_archive(FILES), mtime=0))
(ROOT / "skill.zip").write_bytes(zip_archive(FILES))

for label, name in {
    "parent": "../outside.md",
    "absolute": "/outside.md",
    "drive": "C:/outside.md",
    "backslash": "..\\outside.md",
}.items():
    (ROOT / f"unsafe-{label}.tar").write_bytes(tar_archive({name: b"escape"}))
    (ROOT / f"unsafe-{label}.zip").write_bytes(zip_archive({name: b"escape"}))

(ROOT / "many.zip").write_bytes(zip_archive({f"{i}.md": b"x" for i in range(1001)}))
(ROOT / "large.zip").write_bytes(zip_archive({"large.md": b"x" * (25 * 1024 * 1024 + 1)}))
