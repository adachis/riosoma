#!/usr/bin/env python3
"""Checks the Riosoma test fleet Compose file against the fleet rules.

The rules come from the fleet brief.  A service has to pin its image, declare a
healthcheck, cap its memory, and belong to a profile.  Every published port has
to stay on the loopback interface, and no two services may claim the same host
port.  License acceptance has to stay off until the owner turns it on.  Image
tags have to exist in their registry, which needs network access, so --offline
skips that part.

Exit status is 0 when nothing failed.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - the message is the point
    sys.exit(
        "PyYAML is required.  Install it with `pip3 install --break-system-packages pyyaml` "
        "or run inside a virtual environment that has it."
    )

HERE = Path(__file__).resolve().parent
COMPOSE_FILE = HERE / "compose.yaml"

# Registries that answer the v2 API without credentials.  Anything else goes
# through the WWW-Authenticate challenge, so adding a registry is not required
# for the checks to work.
MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)

# Environment variables that accept a license when they carry a value.  The
# fleet never sets them directly, only through an interpolation with an empty
# default.
LICENSE_KEY = re.compile(r"(ACCEPT_EULA|EULA|LICENSE|ACCEPT_LICENSE)", re.IGNORECASE)
LICENSE_GATE = re.compile(r"^\$\{FLEET_ACCEPT_[A-Z0-9_]+:-\}$")
ACCEPTED_VALUES = {"accept", "accepted", "y", "yes", "true", "1", "i_accept", "agree"}

PRERELEASE = re.compile(r"(^|[-.])(rc|alpha|beta|pre|snapshot|nightly|edge|head)([-.]|$)", re.IGNORECASE)

USER_AGENT = "riosoma-test-fleet-validator"

# Docker Hub answers its API on a different host than its web site.  Asking
# docker.io for a manifest returns an HTML page with status 200, which would look
# like a successful check, so the API host is spelled out here.
API_HOSTS = {
    "docker.io": "registry-1.docker.io",
    "index.docker.io": "registry-1.docker.io",
}

MANIFEST_MEDIA_TYPES = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
)


class Problem:
    """One finding, either a failure or a warning."""

    def __init__(self, kind: str, service: str, message: str) -> None:
        self.kind = kind
        self.service = service
        self.message = message

    def render(self) -> str:
        where = f"{self.service}: " if self.service else ""
        return f"{self.kind.upper()}  {where}{self.message}"


# ---------------------------------------------------------------------------
# Image references
# ---------------------------------------------------------------------------


class ImageRef:
    """A parsed image reference."""

    def __init__(self, raw: str) -> None:
        self.raw = raw
        self.digest: str | None = None
        remainder = raw
        if "@" in remainder:
            remainder, self.digest = remainder.rsplit("@", 1)

        self.registry = "docker.io"
        first = remainder.split("/")[0]
        if "/" in remainder and ("." in first or ":" in first or first == "localhost"):
            self.registry, remainder = remainder.split("/", 1)
        elif "/" not in remainder and self.registry == "docker.io":
            remainder = f"library/{remainder}"
        elif self.registry == "docker.io" and "/" in remainder and remainder.count("/") == 1:
            # A namespace without a registry host, such as teableio/teable.
            pass

        if ":" in remainder.rsplit("/", 1)[-1]:
            self.repository, self.tag = remainder.rsplit(":", 1)
        else:
            self.repository, self.tag = remainder, None

    @property
    def pinned_by_digest(self) -> bool:
        return bool(self.digest and self.digest.startswith("sha256:"))

    @property
    def api_host(self) -> str:
        return API_HOSTS.get(self.registry, self.registry)

    @property
    def name(self) -> str:
        tag = f":{self.tag}" if self.tag else ""
        digest = f"@{self.digest}" if self.digest else ""
        host = "" if self.registry == "docker.io" else f"{self.registry}/"
        return f"{host}{self.repository}{tag}{digest}"

    def __str__(self) -> str:
        return self.name


def expand_host_port(value: str) -> list[int]:
    """Turns a published port or range into a list of host ports."""
    if "-" in value:
        low, high = value.split("-", 1)
        return list(range(int(low), int(high) + 1))
    return [int(value)]


def iter_published_ports(service: str, spec) -> list[tuple[str, int, Problem | None]]:
    """Yields (protocol, host port, problem) for every published port."""
    found: list[tuple[str, int, Problem | None]] = []
    for entry in spec:
        if isinstance(entry, dict):
            protocol = str(entry.get("protocol") or "tcp")
            host_ip = str(entry.get("host_ip") or "")
            published = entry.get("published")
            if published is None:
                found.append((protocol, -1, Problem("error", service, "long syntax port entry has no published port")))
                continue
            host_spec = str(published)
            source = f"{host_ip}:{host_spec}" if host_ip else host_spec
        else:
            text = str(entry)
            protocol = "tcp"
            if "/" in text:
                text, protocol = text.rsplit("/", 1)
            parts = text.split(":")
            if len(parts) == 3:
                host_ip, host_spec, _container = parts
            elif len(parts) == 2:
                host_ip, host_spec = "", parts[0]
            elif len(parts) == 1:
                # A bare container port means the host port is chosen at random,
                # which also means the binding is not the loopback interface.
                found.append(
                    (
                        protocol,
                        -1,
                        Problem("error", service, f"port '{entry}' publishes without a host IP, so it binds every interface"),
                    )
                )
                continue
            else:
                found.append((protocol, -1, Problem("error", service, f"port '{entry}' is not a form this checker understands")))
                continue
            source = text

        if host_ip != "127.0.0.1":
            found.append(
                (
                    protocol,
                    -1,
                    Problem("error", service, f"port '{source}' is not bound to 127.0.0.1"),
                )
            )
            continue

        try:
            ports = expand_host_port(host_spec)
        except ValueError:
            found.append((protocol, -1, Problem("error", service, f"port '{source}' is not numeric")))
            continue
        for port in ports:
            found.append((protocol, port, None))
    return found


# ---------------------------------------------------------------------------
# Registry lookups
# ---------------------------------------------------------------------------


class RegistryClient:
    """Reads tags and manifests from the registries the fleet uses."""

    def __init__(self, cache_path: Path, offline: bool) -> None:
        self.cache_path = cache_path
        self.offline = offline
        self.tokens: dict[str, str] = {}
        self.cache: dict[str, object] = {}
        if not offline and cache_path.exists():
            try:
                self.cache = json.loads(cache_path.read_text())
            except (OSError, ValueError):
                self.cache = {}

    def save(self) -> None:
        if self.offline:
            return
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(json.dumps(self.cache, indent=1, sort_keys=True))
        except OSError:
            pass

    def _request(self, url: str, headers: dict[str, str] | None = None) -> tuple[bytes, dict[str, str], int]:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read(), {k.lower(): v for k, v in response.headers.items()}, response.status

    def _token(self, registry: str, repository: str) -> str | None:
        """Follows the bearer challenge, which every registry here supports."""
        key = f"{registry}/{repository}"
        if key in self.tokens:
            return self.tokens[key]
        try:
            self._request(f"https://{registry}/v2/")
            self.tokens[key] = ""
            return ""
        except urllib.error.HTTPError as error:
            challenge = error.headers.get("WWW-Authenticate", "") if error.headers else ""
        match = re.search(r'Bearer realm="([^"]+)"', challenge)
        if not match:
            raise LookupError(f"{registry} asked for authentication this checker cannot provide")
        realm = match.group(1)
        service = re.search(r'service="([^"]*)"', challenge)
        query = []
        if service:
            query.append(f"service={urllib.parse.quote(service.group(1))}")
        query.append(f"scope=repository:{urllib.parse.quote(repository)}:pull")
        body, _, _ = self._request(f"{realm}?{'&'.join(query)}")
        payload = json.loads(body)
        token = payload.get("token") or payload.get("access_token") or ""
        self.tokens[key] = token
        return token

    def manifest(self, ref: ImageRef, attempt: int = 0) -> dict:
        """Returns {'exists': bool, 'architectures': [...], 'detail': str}."""
        target = ref.digest or ref.tag
        cache_key = f"manifest:{ref.api_host}/{ref.repository}:{target}"
        if cache_key in self.cache:
            return self.cache[cache_key]  # type: ignore[return-value]

        url = f"https://{ref.api_host}/v2/{ref.repository}/manifests/{target}"
        headers = {"Accept": MANIFEST_ACCEPT}
        try:
            token = self._token(ref.api_host, ref.repository)
        except LookupError as error:
            return {"exists": None, "architectures": [], "detail": str(error)}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        try:
            body, response_headers, _status = self._request(url, headers)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                result = {"exists": False, "architectures": [], "detail": "registry returned 404"}
                self.cache[cache_key] = result
                return result
            if error.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(2 * (attempt + 1))
                return self.manifest(ref, attempt + 1)
            return {"exists": None, "architectures": [], "detail": f"registry returned {error.code}"}
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            return {"exists": None, "architectures": [], "detail": f"unreachable ({reason})"}

        # A registry that answers with something other than a manifest is not
        # answering the question, and guessing would hide a broken tag.
        content_type = response_headers.get("content-type", "")
        if not any(media in content_type for media in MANIFEST_MEDIA_TYPES):
            return {"exists": None, "architectures": [], "detail": f"unexpected content type {content_type or 'none'}"}

        architectures: list[str] = []
        try:
            payload = json.loads(body)
        except ValueError:
            return {"exists": None, "architectures": [], "detail": "manifest body is not JSON"}
        if not payload.get("schemaVersion"):
            return {"exists": None, "architectures": [], "detail": "manifest body has no schemaVersion"}
        for entry in payload.get("manifests", []):
            platform = entry.get("platform") or {}
            if platform.get("os") == "linux" and platform.get("architecture"):
                architectures.append(platform["architecture"])
        if not architectures:
            # A single manifest carries no platform list, so the architecture
            # lives in the config blob.  Single architecture images are exactly
            # the ones that need a platform override, so this second request is
            # what makes the override check meaningful.
            config_digest = (payload.get("config") or {}).get("digest")
            if config_digest:
                architectures = self.config_architectures(ref, config_digest, headers)
        result = {
            "exists": True,
            "architectures": sorted(set(architectures)),
            "detail": response_headers.get("docker-content-digest", ""),
        }
        self.cache[cache_key] = result
        return result

    def config_architectures(self, ref: ImageRef, digest: str, headers: dict[str, str]) -> list[str]:
        cache_key = f"config:{ref.api_host}/{ref.repository}:{digest}"
        if cache_key in self.cache:
            return list(self.cache[cache_key])  # type: ignore[arg-type]
        try:
            body, _, _ = self._request(f"https://{ref.api_host}/v2/{ref.repository}/blobs/{digest}", headers)
            architecture = (json.loads(body) or {}).get("architecture") or ""
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError):
            architecture = ""
        architectures = [architecture] if architecture else []
        self.cache[cache_key] = architectures
        return architectures

    def tag_matches_digest(self, ref: ImageRef) -> bool | None:
        """Confirms a digest pin still matches what the tag points at."""
        if not (ref.tag and ref.pinned_by_digest):
            return None
        cache_key = f"tag-digest:{ref.api_host}/{ref.repository}:{ref.tag}"
        if cache_key not in self.cache:
            url = f"https://{ref.api_host}/v2/{ref.repository}/manifests/{ref.tag}"
            headers = {"Accept": MANIFEST_ACCEPT}
            try:
                token = self._token(ref.api_host, ref.repository)
            except LookupError:
                return None
            if token:
                headers["Authorization"] = f"Bearer {token}"
            try:
                _body, response_headers, _status = self._request(url, headers)
                published = response_headers.get("docker-content-digest", "")
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
                published = ""
            self.cache[cache_key] = published
        published = str(self.cache[cache_key])
        if not published:
            return None
        return published == ref.digest


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def parse_memory(value) -> int | None:
    """Turns a Compose memory value into bytes."""
    if isinstance(value, (int, float)):
        return int(value)
    match = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*([kKmMgGtT]?)[iI]?[bB]?\s*", str(value))
    if not match:
        return None
    number = float(match.group(1))
    unit = (match.group(2) or "").lower()
    factor = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}[unit]
    return int(number * factor)


def check_memory(service: str, spec: dict) -> list[Problem]:
    limits = ((spec.get("deploy") or {}).get("resources") or {}).get("limits") or {}
    memory = limits.get("memory")
    if memory is None:
        return [Problem("error", service, "no deploy.resources.limits.memory, so nothing stops it eating the host")]
    if parse_memory(memory) is None:
        return [Problem("error", service, f"memory limit '{memory}' is not a size this checker understands")]
    if parse_memory(memory) == 0:
        return [Problem("error", service, "memory limit is zero")]
    return []


def check_healthcheck(service: str, spec: dict) -> list[Problem]:
    if spec.get("x-fleet-job"):
        return []
    healthcheck = spec.get("healthcheck")
    if not healthcheck:
        return [Problem("error", service, "no healthcheck, so --wait cannot tell ready from crashed")]
    if healthcheck.get("disable"):
        return [Problem("error", service, "healthcheck is disabled")]
    test = healthcheck.get("test")
    if not test:
        return [Problem("error", service, "healthcheck has no test")]
    return []


def check_profiles(service: str, spec: dict) -> list[Problem]:
    profiles = spec.get("profiles") or []
    if isinstance(profiles, str):
        profiles = [profiles]
    if not profiles:
        return [Problem("error", service, "no profiles, so it would start with every command")]
    problems = []
    if service not in profiles:
        problems.append(
            Problem("error", service, f"profiles {sorted(profiles)} do not include a profile named after the service")
        )
    return problems


def check_image_tag(service: str, ref: ImageRef) -> list[Problem]:
    problems = []
    if not ref.tag and not ref.pinned_by_digest:
        problems.append(Problem("error", service, f"image '{ref.raw}' has no tag, which means latest"))
    if ref.tag == "latest":
        problems.append(Problem("error", service, f"image '{ref.raw}' is pinned to latest"))
    if not ref.pinned_by_digest:
        if ref.tag and not any(character.isdigit() for character in ref.tag):
            problems.append(
                Problem("error", service, f"image tag '{ref.tag}' carries no version, pin a digest or a release tag")
            )
        if ref.tag and PRERELEASE.search(ref.tag):
            problems.append(Problem("warning", service, f"image tag '{ref.tag}' looks like a pre-release"))
    return problems


def check_environment(service: str, spec: dict) -> list[Problem]:
    """Fails when a license variable arrives already accepted."""
    environment = spec.get("environment")
    pairs: list[tuple[str, str]] = []
    if isinstance(environment, dict):
        pairs = [(str(key), "" if value is None else str(value)) for key, value in environment.items()]
    elif isinstance(environment, list):
        for item in environment:
            text = str(item)
            if "=" in text:
                key, value = text.split("=", 1)
                pairs.append((key, value))
    problems = []
    for key, value in pairs:
        if not LICENSE_KEY.search(key):
            continue
        if LICENSE_GATE.match(value):
            continue
        if value.strip().lower() in ACCEPTED_VALUES:
            problems.append(
                Problem("error", service, f"{key} accepts a license by default, use ${{FLEET_ACCEPT_*:-}} instead")
            )
        elif value.startswith("${"):
            default = value.split(":-", 1)[1].rstrip("}") if ":-" in value else "unset"
            problems.append(
                Problem("error", service, f"{key} interpolates with a default of '{default}', which may accept a license")
            )
        else:
            problems.append(
                Problem("error", service, f"{key} is set to '{value}', a license must stay unaccepted by default")
            )
    return problems


def check_volumes(service: str, spec: dict, declared: set[str]) -> list[Problem]:
    problems = []
    for entry in spec.get("volumes") or []:
        if isinstance(entry, dict):
            source = entry.get("source") or ""
            kind = entry.get("type") or ("bind" if str(source).startswith((".", "/")) else "volume")
        else:
            text = str(entry)
            if ":" not in text:
                continue
            source = text.split(":", 1)[0]
            kind = "bind" if source.startswith((".", "/", "~")) else "volume"
        if kind == "volume":
            if not str(source).startswith("fleet-"):
                problems.append(Problem("error", service, f"named volume '{source}' is not prefixed with fleet-"))
            if source not in declared:
                problems.append(Problem("warning", service, f"named volume '{source}' is not declared at the top level"))
        else:
            path = Path(source)
            if not path.is_absolute():
                path = HERE / source
            if not path.exists():
                problems.append(Problem("error", service, f"bind mount source '{source}' does not exist"))
    return problems


def check_platform(service: str, spec: dict, architectures: list[str]) -> list[Problem]:
    """Cross-checks the platform override against what the registry publishes."""
    platform = spec.get("platform")
    if not architectures:
        return []
    has_arm64 = "arm64" in architectures
    if not has_arm64 and platform != "linux/amd64":
        return [
            Problem(
                "error",
                service,
                f"image publishes {', '.join(architectures)} only, so it needs platform: linux/amd64",
            )
        ]
    if has_arm64 and platform == "linux/amd64":
        return [
            Problem(
                "warning",
                service,
                "image publishes arm64, so platform: linux/amd64 forces needless emulation",
            )
        ]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--compose", default=str(COMPOSE_FILE), help="path to the Compose file")
    parser.add_argument("--offline", action="store_true", help="skip registry lookups")
    parser.add_argument("--quiet", action="store_true", help="only print failures and warnings")
    args = parser.parse_args()

    compose_path = Path(args.compose).resolve()
    if not compose_path.exists():
        print(f"error: {compose_path} does not exist")
        return 1

    document = yaml.safe_load(compose_path.read_text())
    services = document.get("services") or {}
    if not services:
        print(f"error: {compose_path} declares no services")
        return 1
    declared_volumes = set((document.get("volumes") or {}).keys())

    problems: list[Problem] = []
    host_ports: dict[tuple[str, int], str] = {}
    images: dict[str, ImageRef] = {}
    service_specs: dict[str, dict] = {}

    for service, spec in services.items():
        if not isinstance(spec, dict):
            problems.append(Problem("error", service, "service entry is not a mapping"))
            continue
        service_specs[service] = spec
        if not spec.get("image"):
            problems.append(Problem("error", service, "no image, and this fleet is images only"))
            continue
        ref = ImageRef(str(spec["image"]))
        images[service] = ref

        problems.extend(check_image_tag(service, ref))
        problems.extend(check_healthcheck(service, spec))
        problems.extend(check_memory(service, spec))
        problems.extend(check_profiles(service, spec))
        problems.extend(check_environment(service, spec))
        problems.extend(check_volumes(service, spec, declared_volumes))

        for protocol, port, problem in iter_published_ports(service, spec.get("ports") or []):
            if problem:
                problems.append(problem)
                continue
            key = (protocol, port)
            owner = host_ports.get(key)
            if owner and owner != service:
                problems.append(
                    Problem("error", service, f"host port {port}/{protocol} is already published by {owner}")
                )
            else:
                host_ports[key] = service

    for volume in sorted(declared_volumes):
        if not volume.startswith("fleet-"):
            problems.append(Problem("error", "", f"declared volume '{volume}' is not prefixed with fleet-"))

    # Every profile has to name a service or a documented group, and every group
    # has to select something.  A group that selects nothing is a typo.
    groups = {
        "sql",
        "warehouse",
        "nosql",
        "search",
        "storage",
        "identity",
        "secrets",
        "migration-sources",
        "mail",
        "misc",
        "druid",
    }
    seen_profiles: dict[str, int] = {}
    for service, spec in service_specs.items():
        for profile in spec.get("profiles") or []:
            seen_profiles[profile] = seen_profiles.get(profile, 0) + 1
    for group in sorted(groups):
        if group not in seen_profiles:
            problems.append(Problem("error", "", f"group profile '{group}' selects no service"))

    if not args.offline:
        client = RegistryClient(
            Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "riosoma-test-fleet" / "registry.json",
            offline=False,
        )
        unique: dict[str, list[str]] = {}
        for service, ref in images.items():
            # An unpinned image is already reported, and there is nothing to look
            # up, because the reference names no artifact.
            if not ref.tag and not ref.pinned_by_digest:
                continue
            unique.setdefault(ref.name, []).append(service)
        if not args.quiet:
            print(f"checking {len(unique)} images against their registries")

        def look_up(name: str) -> tuple[str, dict]:
            ref = ImageRef(name)
            return name, client.manifest(ref)

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = dict(pool.map(look_up, sorted(unique)))

        for name, services_with_image in sorted(unique.items()):
            result = results[name]
            exists = result.get("exists")
            architectures = result.get("architectures") or []
            if exists is False:
                problems.append(
                    Problem("error", ", ".join(services_with_image), f"image '{name}' does not exist in its registry")
                )
                continue
            if exists is None:
                problems.append(
                    Problem(
                        "warning",
                        ", ".join(services_with_image),
                        f"image '{name}' could not be verified ({result.get('detail')})",
                    )
                )
            for service in services_with_image:
                problems.extend(check_platform(service, service_specs[service], architectures))
            matches = client.tag_matches_digest(ImageRef(name))
            if matches is False:
                problems.append(
                    Problem(
                        "warning",
                        ", ".join(services_with_image),
                        f"image '{name}' pins a digest its tag no longer points at.  The digest still resolves, but the pin is stale",
                    )
                )
        client.save()
    else:
        if not args.quiet:
            print("offline mode, registry lookups skipped")

    errors = [problem for problem in problems if problem.kind == "error"]
    warnings = [problem for problem in problems if problem.kind == "warning"]

    for problem in warnings:
        print(problem.render())
    for problem in errors:
        print(problem.render())

    if not args.quiet:
        print(
            f"{len(services)} services, {len(host_ports)} published host ports, "
            f"{len(declared_volumes)} volumes, {len(warnings)} warnings, {len(errors)} errors"
        )

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
