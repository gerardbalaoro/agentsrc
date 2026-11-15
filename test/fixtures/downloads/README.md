# Download Fixtures

`generate.py` creates these archives with Python's standard-library `tarfile`, `zipfile`, and `gzip`
modules. Tests read the checked-in files and do not need Python.

The valid archives contain a skill, an executable script, and a nested guide under `bundle/demo`.
Unsafe archives contain a parent path, an absolute path, a Windows drive path, or a backslash parent
path. `many.zip` contains 1,001 entries. `large.zip` expands to 25 MiB plus one byte.

To regenerate them:

```bash
python3 test/fixtures/downloads/generate.py
```
