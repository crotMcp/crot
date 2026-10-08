#!/usr/bin/env python3
"""Exact-path exec rules of the CROT L1 policy for the host's unconfined profiles.

Prints one `allow ix "<path>",` line per executable that a loaded host AppArmor
profile in unconfined mode attaches to and grants user namespaces (Ubuntu
24.04's application profiles such as `profile chrome /opt/google/chrome/chrome
flags=(unconfined) { userns, }`). scripts/l1-install.sh puts them into the
crot-l1-<v> profile, where they keep the L1 label of a confined process that
executes such a program (ARCHITECTURE.md AD-20 point 3, docs/L1.md).

Only what is certain is emitted: the profile is loaded and its mode is
unconfined, its file grants `userns`, and the attachment expands (variables of
the file, @{multiarch}, {a,b} alternations) to literal absolute paths. Any
pattern that stays a glob is left out: such a program keeps today's behaviour
(its host profile joins the stack; nothing is granted).

Environment (tests): CROT_L1_APPARMOR_DIR (default /etc/apparmor.d),
CROT_L1_APPARMOR_PROFILES (default /sys/kernel/security/apparmor/profiles),
CROT_L1_MULTIARCH (default: dpkg-architecture, gcc -print-multiarch, uname -m).
"""

import os
import platform
import re
import subprocess
import sys

POLICY_DIR = os.environ.get("CROT_L1_APPARMOR_DIR", "/etc/apparmor.d")
PROFILES = os.environ.get("CROT_L1_APPARMOR_PROFILES", "/sys/kernel/security/apparmor/profiles")
TOKEN = r'(?:"[^"\n]*"|[^\s"]+)'
HEADER = re.compile(r"^\s*profile\s+(" + TOKEN + r")\s+(" + TOKEN + r")\s+flags\s*=\s*\(([^)]*)\)\s*\{", re.M)
VARIABLE = re.compile(r"^\s*@\{([A-Za-z0-9_]+)\}\s*=\s*(\S+)\s*$", re.M)
USERNS = re.compile(r"^\s*(?:allow\s+)?userns(?:\s+create)?\s*,", re.M)
LITERAL = re.compile(r"^/[A-Za-z0-9._+\-/ ]+$")


def multiarch() -> str:
    if os.environ.get("CROT_L1_MULTIARCH"):
        return os.environ["CROT_L1_MULTIARCH"]
    for cmd in (["dpkg-architecture", "-qDEB_HOST_MULTIARCH"], ["gcc", "-print-multiarch"]):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
            if re.fullmatch(r"[a-z0-9_]+-linux-gnu[a-z0-9_]*", out):
                return out
        except (OSError, subprocess.SubprocessError):
            pass
    return {"x86_64": "x86_64-linux-gnu", "aarch64": "aarch64-linux-gnu"}.get(platform.machine(), "")


def loaded_unconfined() -> set:
    try:
        with open(PROFILES, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return set()
    names = set()
    for line in lines:
        m = re.fullmatch(r"(.+) \(unconfined\)", line)
        if m:
            names.add(m.group(1))
    return names


def unquote(token: str) -> str:
    return token[1:-1] if token.startswith('"') and token.endswith('"') else token


def braces(pattern: str) -> list:
    """Expands {a,b} alternations (nested); returns the pattern unchanged when unbalanced."""
    start = pattern.find("{")
    if start < 0:
        return [pattern]
    depth, parts, last = 0, [], start + 1
    for i in range(start, len(pattern)):
        c = pattern[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                parts.append(pattern[last:i])
                head, tail = pattern[:start], pattern[i + 1 :]
                return [x for p in parts for x in braces(head + p + tail)]
        elif c == "," and depth == 1:
            parts.append(pattern[last:i])
            last = i + 1
    return [pattern]


def expand(pattern: str, variables: dict, seen: int = 0) -> list:
    m = re.search(r"@\{([A-Za-z0-9_]+)\}", pattern)
    if not m:
        return braces(pattern)
    if seen > 8 or m.group(1) not in variables:
        return []
    return [
        x
        for value in braces(variables[m.group(1)])
        for x in expand(pattern[: m.start()] + value + pattern[m.end() :], variables, seen + 1)
    ]


def main() -> int:
    loaded = loaded_unconfined()
    if not loaded:
        return 0
    paths = set()
    try:
        entries = sorted(os.listdir(POLICY_DIR))
    except OSError:
        return 0
    for entry in entries:
        file = os.path.join(POLICY_DIR, entry)
        if entry.startswith(".") or "dpkg-" in entry or not os.path.isfile(file) or entry.startswith("crot-l1-"):
            continue
        try:
            with open(file, encoding="utf-8") as f:
                text = f.read()
        except (OSError, UnicodeDecodeError):
            continue
        text = re.sub(r"(?m)^\s*#.*$", "", text)
        variables = {"multiarch": multiarch()} if multiarch() else {}
        variables.update({m.group(1): m.group(2) for m in VARIABLE.finditer(text)})
        headers = list(HEADER.finditer(text))
        # One profile per file (Ubuntu's application profiles): its userns rule is the file's.
        if len(headers) != 1 or not USERNS.search(text):
            continue
        name, attach, flags = unquote(headers[0].group(1)), unquote(headers[0].group(2)), headers[0].group(3)
        if "unconfined" not in [f.strip() for f in flags.split(",")] or name not in loaded:
            continue
        for p in expand(attach, variables):
            if LITERAL.match(p) and "//" not in p and "/../" not in p and not p.startswith("/usr/lib/crot/"):
                paths.add(os.path.normpath(p))
    for p in sorted(paths):
        print(f'  allow ix "{p}",')
    return 0


if __name__ == "__main__":
    sys.exit(main())
