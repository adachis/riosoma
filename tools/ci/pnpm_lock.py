"""Read a pnpm 9 lockfile without a YAML library and walk its dependency graph.

The security job runs before any install, and a pull request's base lockfile is never installed, so
this reads the lockfile text directly.  It understands the block mappings, block lists, quoted
scalars, and one-line flow values that pnpm writes, which is all a lockfile contains.
"""

from collections import deque
import posixpath


PROD_SECTIONS = ("dependencies", "optionalDependencies")
ALL_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies")


def _scalar(text):
    text = text.strip()
    if text == "{}":
        return {}
    if text == "[]":
        return []
    if len(text) >= 2 and text[0] == text[-1] == "'":
        return text[1:-1].replace("''", "'")
    if len(text) >= 2 and text[0] == text[-1] == '"':
        return text[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return text


def _split_key(text):
    """Split "key: value" where the key may be quoted and contain colons."""
    if text[0] in "'\"":
        quote = text[0]
        index = 1
        while index < len(text):
            if text[index] == quote:
                if quote == "'" and text[index + 1 : index + 2] == "'":
                    index += 2
                    continue
                break
            index += 1
        key = _scalar(text[: index + 1])
        rest = text[index + 1 :]
        if not rest.startswith(":"):
            raise ValueError(f"Expected a colon after {text!r}")
        return key, rest[1:].strip()
    key, separator, rest = text.partition(": ")
    if not separator:
        if not text.endswith(":"):
            raise ValueError(f"Expected a key in {text!r}")
        return text[:-1], ""
    return key, rest.strip()


def parse(text):
    """Parse lockfile text into dictionaries, lists, and strings."""
    lines = text.splitlines()
    root = {}
    # Each frame is (indent of its entries, container).
    stack = [(0, root)]
    pending = None
    index = 0
    while index < len(lines):
        raw = lines[index]
        number = index + 1
        index += 1
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        if pending is not None:
            parent, key, parent_indent = pending
            pending = None
            if indent > parent_indent:
                container = [] if line.startswith("- ") or line == "-" else {}
                parent[key] = container
                stack.append((indent, container))
            else:
                parent[key] = None
        while indent < stack[-1][0]:
            stack.pop()
        if indent != stack[-1][0]:
            raise ValueError(f"Line {number}: unexpected indentation")
        container = stack[-1][1]
        try:
            if line.startswith("- ") or line == "-":
                if not isinstance(container, list):
                    raise ValueError("a list item outside a list")
                container.append(_scalar(line[2:]))
                continue
            if not isinstance(container, dict):
                raise ValueError("a mapping entry inside a list")
            key, value = _split_key(line)
        except ValueError as error:
            raise ValueError(f"Line {number}: {error}") from None
        if value[:1] in ("|", ">"):
            # A block scalar holds every following line indented deeper than its key.
            block = []
            while index < len(lines) and (
                not lines[index].strip() or len(lines[index]) - len(lines[index].lstrip(" ")) > indent
            ):
                block.append(lines[index].strip())
                index += 1
            container[key] = ("\n" if value[0] == "|" else " ").join(block).strip()
        elif value == "":
            pending = (container, key, indent)
        else:
            container[key] = _scalar(value)
    if pending is not None:
        parent, key, _ = pending
        parent[key] = None
    return root


def split_key(key):
    """Return (name, version) for a snapshot key such as "@a/b@1.0.0(peer@2.0.0)"."""
    base = key.split("(", 1)[0]
    at = base.rfind("@")
    if at <= 0:
        raise ValueError(f"Not a package key: {key!r}")
    return base[:at], base[at + 1 :]


def _matches_platform(value, constraint):
    """Match pnpm's inline or block platform lists, including exclusions."""
    if not constraint:
        return True
    if isinstance(constraint, str):
        constraint = [_scalar(item) for item in constraint.strip("[]").split(",") if item.strip()]
    allowed = {item for item in constraint if not item.startswith("!")}
    return f"!{value}" not in constraint and (not allowed or value in allowed or "any" in allowed)


class Lockfile:
    def __init__(self, text):
        data = parse(text) if text else {}
        self.importers = data.get("importers") or {}
        self.snapshots = data.get("snapshots") or {}
        self.packages_section = data.get("packages") or {}

    @classmethod
    def read(cls, path):
        try:
            with open(path, encoding="utf-8") as source:
                return cls(source.read())
        except FileNotFoundError:
            return cls("")

    def packages(self):
        """Every installed package as a set of (name, version)."""
        return {split_key(key) for key in self.snapshots}

    def direct(self, importer, sections=ALL_SECTIONS):
        """Direct dependencies of an importer as {name: version reference}."""
        entry = self.importers.get(importer) or {}
        result = {}
        for section in sections:
            for name, value in (entry.get(section) or {}).items():
                result[name] = value["version"] if isinstance(value, dict) else value
        return result

    @staticmethod
    def _target(name, reference):
        """Turn a dependency reference into a snapshot key or ("link", path)."""
        if reference.startswith("link:"):
            return ("link", reference[5:])
        base = reference.split("(", 1)[0]
        # An alias records the real package name, as in "string-width@4.2.3".
        if "@" in base.lstrip("@"):
            return reference
        return f"{name}@{reference}"

    def closure(self, importers, sections=PROD_SECTIONS, *, platforms=None, browser=False):
        """Walk from importers through workspace links and snapshots.

        Returns {(name, version): path}, where path is the shortest list of names from the first
        importer to the package, which shows how it arrives.  Optional shipping filters exclude
        incompatible native packages and their dependency branches.
        """
        return self._walk(
            [("importer", importer, [importer]) for importer in importers], sections, platforms, browser
        )

    def closure_of_dependency(self, importer, name):
        """The packages one direct dependency brings with it, not counting itself."""
        reference = self.direct(importer).get(name)
        if reference is None:
            return {}
        target = self._target(name, reference)
        if isinstance(target, tuple):
            linked = posixpath.normpath(posixpath.join(importer, target[1]))
            return self._walk([("importer", linked, [name])], PROD_SECTIONS)
        found = self._walk([("snapshot", target, [name])], PROD_SECTIONS)
        found.pop(split_key(target), None)
        return found

    def _walk(self, seeds, sections, platforms=None, browser=False):
        found = {}
        queue = deque()
        seen_importers = set()
        seen_keys = set()
        for kind, ident, path in seeds:
            seen = seen_importers if kind == "importer" else seen_keys
            if ident not in seen and (kind != "importer" or ident in self.importers):
                seen.add(ident)
                queue.append((kind, ident, path))
        while queue:
            kind, ident, path = queue.popleft()
            if kind == "importer":
                for name, reference in self.direct(ident, sections).items():
                    target = self._target(name, reference)
                    if isinstance(target, tuple):
                        linked = posixpath.normpath(posixpath.join(ident, target[1]))
                        if linked not in seen_importers and linked in self.importers:
                            seen_importers.add(linked)
                            queue.append(("importer", linked, path + [name]))
                    elif target not in seen_keys:
                        seen_keys.add(target)
                        queue.append(("snapshot", target, path + [name]))
                continue
            try:
                package = split_key(ident)
            except ValueError:
                continue
            metadata = self.packages_section.get("@".join(package)) or {}
            if browser and (metadata.get("os") or metadata.get("cpu")):
                continue
            if platforms is not None and not any(
                all(_matches_platform(value, metadata.get(key)) for key, value in zip(("os", "cpu", "libc"), platform))
                for platform in platforms
            ):
                continue
            found.setdefault(package, path)
            snapshot = self.snapshots.get(ident) or {}
            for section in PROD_SECTIONS:
                for name, reference in (snapshot.get(section) or {}).items():
                    target = self._target(name, reference)
                    if isinstance(target, tuple) or target in seen_keys:
                        continue
                    seen_keys.add(target)
                    queue.append(("snapshot", target, path + [name]))
        return found
