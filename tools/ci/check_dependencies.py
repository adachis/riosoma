"""Check that every direct dependency is used and says why it is here.

Every package.json in the workspace and in integrations/ lists its direct dependencies, and
dependency-reasons.toml gives each one a reason.  This fails when a dependency has no reason, when
the file still lists one nothing declares, or when a package declares a dependency that its source,
configs, and scripts never use.  A dependency used in a way the scan cannot see is listed with an
"unseen" explanation instead.  See docs/developer/dependencies.md.
"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib

import pnpm_lock


ROOT = Path(__file__).resolve().parents[2]
REASONS = "dependency-reasons.toml"
SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
TEXT_SUFFIXES = {
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".json", ".jsonc", ".css",
    ".html", ".yml", ".yaml", ".toml", ".sh", ".py", ".vue", ".svelte",
}
SKIPPED_PARTS = {"node_modules", "dist", ".turbo", "coverage", "playwright-report", "test-results", ".git"}
# A package name inside quotes or after a CSS @import, optionally followed by a subpath.
SPECIFIER = re.compile(r"""(?:["'`]|@import\s+(?:url\()?)(@[a-z0-9][\w.~-]*/[\w.~-]+|[a-z0-9][\w.~-]*)(?=["'`/)])""")
NODE_PREFIX = re.compile(r"""["'`]node:[a-z_/]+["'`]""")
COMMAND_WORD = r"(?:^|[\s;&|(`'\"=])" "{}" r"(?=$|[\s;&|)`'\"])"
NODE_BUILTINS = {
    "assert", "async_hooks", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "events",
    "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
    "querystring", "readline", "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "v8",
    "vm", "worker_threads", "zlib",
}


def workspace_packages(root):
    """Directories with a package.json: the root, apps, packages, and every integration."""
    found = [Path(".")]
    for group in ("apps", "packages", "integrations"):
        directory = root / group
        if directory.is_dir():
            for child in sorted(directory.iterdir()):
                if (child / "package.json").is_file():
                    found.append(child.relative_to(root))
    return found


def declared(manifest):
    """{name: specifier} for every direct dependency in a manifest."""
    result = {}
    for section in SECTIONS:
        for name, specifier in (manifest.get(section) or {}).items():
            result.setdefault(name, specifier)
    return result


def listed_files(root):
    try:
        output = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=root, check=True, capture_output=True,
        ).stdout.decode()
        paths = [Path(p) for p in output.split("\0") if p]
    except (OSError, subprocess.CalledProcessError):
        paths = []
        for directory, names, files in os.walk(root):
            names[:] = [n for n in names if n not in SKIPPED_PARTS and not n.startswith(".")]
            paths += [Path(directory, f).relative_to(root) for f in files]
    return [p for p in paths if not SKIPPED_PARTS & set(p.parts) and (root / p).is_file()]


def read_text(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


class Usage:
    """What one package's files reference: module names, script text, and tsconfig types."""

    def __init__(self):
        self.specifiers = set()
        self.commands = []
        self.types = set()

    def add_file(self, relative, text):
        name = relative.name
        # The automatic JSX runtime imports react/jsx-runtime from every JSX file.
        if relative.suffix in (".tsx", ".jsx"):
            self.specifiers.add("react")
        if name == "package.json":
            try:
                manifest = json.loads(text)
            except ValueError:
                manifest = {}
            for section in SECTIONS:
                manifest.pop(section, None)
            self.commands += [str(v) for v in (manifest.get("scripts") or {}).values()]
            text = json.dumps(manifest)
        elif relative.suffix in (".yml", ".yaml", ".sh") or name == "Dockerfile":
            self.commands.append(text)
        if name.startswith("tsconfig") and relative.suffix == ".json":
            for listed in re.findall(r'"types"\s*:\s*\[([^\]]*)\]', text):
                self.types.update(re.findall(r'"([^"]+)"', listed))
        self.specifiers.update(match.group(1) for match in SPECIFIER.finditer(text))
        if NODE_PREFIX.search(text):
            self.specifiers.add("node:")

    def uses_command(self, word):
        pattern = re.compile(COMMAND_WORD.format(re.escape(word)), re.MULTILINE)
        return any(pattern.search(command) for command in self.commands)


def scan_usage(root, packages, files):
    usage = {package: Usage() for package in packages}
    nested = sorted((p for p in packages if p != Path(".")), key=lambda p: -len(p.parts))
    for relative in files:
        if relative.suffix not in TEXT_SUFFIXES and relative.name != "Dockerfile":
            continue
        text = read_text(root / relative)
        # The root's dependencies serve the whole repository, so it sees every file.
        usage[Path(".")].add_file(relative, text)
        for package in nested:
            if relative.parts[: len(package.parts)] == package.parts:
                usage[package].add_file(relative, text)
                break
    return usage


def binaries(root, package, name):
    """Command names a dependency installs.

    The installed manifest is read when there is one.  Without an install, the package's own name
    stands in, which is the command name of most tools.
    """
    commands = {name.split("/")[-1]}
    for base in (root / package / "node_modules", root / "node_modules"):
        manifest_path = base / name / "package.json"
        if manifest_path.is_file():
            try:
                bins = json.loads(read_text(manifest_path)).get("bin")
            except ValueError:
                break
            if isinstance(bins, dict):
                commands.update(bins)
            break
    return commands


def types_target(name):
    """The package an @types package describes: @types/a__b describes @a/b."""
    target = name[len("@types/"):]
    return "@" + target.replace("__", "/", 1) if "__" in target else target


def is_referenced(root, package, name, usage):
    if name in usage.specifiers:
        return True
    if any(usage.uses_command(command) for command in binaries(root, package, name)):
        return True
    if name.startswith("@types/"):
        target = types_target(name)
        if target in usage.types or target in usage.specifiers:
            return True
        if target == "node" and usage.specifiers & (NODE_BUILTINS | {"node", "node:"}):
            return True
    return False


def peer_names(lockfiles):
    """{package name: its required peer dependencies}, from the lockfiles' package entries."""
    peers = {}
    for lockfile in lockfiles:
        for key, entry in lockfile.packages_section.items():
            try:
                name, _ = pnpm_lock.split_key(key)
            except ValueError:
                continue
            entry = entry or {}
            meta = entry.get("peerDependenciesMeta") or {}
            optional = {peer for peer, flags in meta.items() if (flags or {}).get("optional") == "true"}
            peers.setdefault(name, set()).update(set(entry.get("peerDependencies") or {}) - optional)
    return peers


def used_dependencies(root, package, names, usage, peers):
    """The declared names the package uses, directly or as a peer of another one it uses."""
    used = {name for name in names if is_referenced(root, package, name, usage)}
    # A package also declares the peers that what it uses requires, so those count as used too.
    while True:
        users = used | usage.specifiers
        more = {
            name for name in names - used
            if any(name in peers.get(user, ()) for user in users)
            or (name.startswith("@types/") and types_target(name) in used)
        }
        if not more:
            return used
        used |= more


def check(root, reasons, files=None):
    """Return a list of problems, each a string."""
    errors = []
    packages = workspace_packages(root)
    files = listed_files(root) if files is None else files
    usage = scan_usage(root, packages, files)
    lockfiles = [pnpm_lock.Lockfile.read(root / "pnpm-lock.yaml")]
    lockfiles += [pnpm_lock.Lockfile.read(root / p / "pnpm-lock.yaml") for p in packages if p != Path(".")]
    peers = peer_names(lockfiles)
    known = {package.as_posix() for package in packages}
    for key in reasons:
        if key not in known:
            errors.append(f"{REASONS}: [\"{key}\"] is not a package with a package.json")
    for package in packages:
        key = package.as_posix()
        manifest = json.loads(read_text(root / package / "package.json") or "{}")
        dependencies = declared(manifest)
        entries = reasons.get(key) or {}
        if not isinstance(entries, dict):
            errors.append(f"{REASONS}: [\"{key}\"] must be a table")
            continue
        for name, entry in sorted(entries.items()):
            if name not in dependencies:
                errors.append(f"{key}: {REASONS} lists {name}, which package.json no longer declares")
            elif not valid_entry(entry):
                errors.append(f"{key}: {name} needs a nonempty reason, and unseen must be a nonempty string")
        used = used_dependencies(root, package, set(dependencies), usage[package], peers)
        for name, specifier in sorted(dependencies.items()):
            entry = entries.get(name)
            internal = str(specifier).startswith("workspace:")
            if entry is None and not internal:
                errors.append(f"{key}: {name} has no reason in {REASONS}")
            unseen = isinstance(entry, dict) and entry.get("unseen")
            if not unseen and name not in used:
                errors.append(
                    f"{key}: {name} is declared but never used; remove it, or explain an unseen use in {REASONS}"
                )
    return errors


def valid_entry(entry):
    if isinstance(entry, str):
        return bool(entry.strip())
    if isinstance(entry, dict):
        reason, unseen = entry.get("reason"), entry.get("unseen")
        return (
            isinstance(reason, str) and bool(reason.strip())
            and (unseen is None or (isinstance(unseen, str) and bool(unseen.strip())))
            and not set(entry) - {"reason", "unseen"}
        )
    return False


def main(root=ROOT):
    try:
        with open(root / REASONS, "rb") as source:
            reasons = tomllib.load(source)
        errors = check(root, reasons)
    except (OSError, ValueError) as error:
        errors = [f"Cannot read {REASONS}: {error}"]
    for error in errors:
        print(f"::error::{error}")
    if not errors:
        print("Every direct dependency is used and has a reason.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
