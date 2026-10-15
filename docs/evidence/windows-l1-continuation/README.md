# Source-pinned Windows L1 continuation evidence

`manifest.json` pins every retained evidence JSON file by SHA256. Existing
historical files are unchanged. New continuation event arrays are saved
losslessly as `SOURCE-Node20-events.gzip.json` and `SOURCE-Node22-events.gzip.json`
to avoid duplicating megabytes of PowerShell stack text. Each wrapper identifies
the exact source commit, encoding, decoded byte length and decoded SHA256.
`*-checks.json` retains original GitHub check records/links; `*-tested-merge.json`
verifies tested checkout parent ancestry, not just the current branch tip.
`*-local-check.json` is explicitly portable Linux evidence, not native Windows.
User archive receipts retain hashes/deduplication and bounded job summaries.

Decode and verify a new event file with Python's standard library. Pass the
actual wrapper path as the first argument. This prints only fixed component,
state and test-summary records, not the full diagnostic stack payloads:

```python
import sys, json, gzip, base64, hashlib, io
from pathlib import Path
f = Path(sys.argv[1])
m = json.loads((f.parent / "manifest.json").read_text())
assert hashlib.sha256(f.read_bytes()).hexdigest() == m[f.name]
w = json.loads(f.read_text())
assert w["formatVersion"] == 1 and w["encoding"] == "gzip+base64"
assert 0 < w["decodedBytes"] <= 16 * 1024 * 1024
compressed = base64.b64decode(w["gzipBase64"], validate=True)
with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
    raw = stream.read(w["decodedBytes"] + 1)
assert len(raw) == w["decodedBytes"]
assert hashlib.sha256(raw).hexdigest() == w["decodedSha256"]
for event in json.loads(raw):
    if event["title"] in {
        "CROT-6A-workspace-view", "CROT-6A-test-summary",
        "CROT-6A-actual-state-ready-actor", "CROT-6A-fixture-setup",
    }:
        print(json.dumps(event, ensure_ascii=False))
```

Do not reinterpret setup/pre-JS/compile failures as a successful denial. In
particular, `control-zero-open` means the Low profile **opened** the raw endpoint;
the helper then rejected readiness. No sensitive IOCTL was invoked. A mounted
experimental view is not an accepted safe backend or a complete filesystem pass.
