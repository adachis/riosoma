from pathlib import Path
from tempfile import TemporaryDirectory
import textwrap
import unittest

import pnpm_lock


LOCK = textwrap.dedent(
    """\
    lockfileVersion: '9.0'

    settings:
      autoInstallPeers: true

    overrides:
      left-pad: 1.3.0

    importers:

      .:
        devDependencies:
          tool:
            specifier: 1.0.0
            version: 1.0.0

      apps/server:
        dependencies:
          '@riosoma/db':
            specifier: workspace:*
            version: link:../../packages/db
          web-framework:
            specifier: 2.0.0
            version: 2.0.0(peer-thing@1.0.0)
        devDependencies:
          test-only:
            specifier: 3.0.0
            version: 3.0.0

      packages/db:
        dependencies:
          driver:
            specifier: 4.0.0
            version: 4.0.0
          aliased:
            specifier: npm:real-name@5.0.0
            version: real-name@5.0.0

    packages:

      '@scope/deprecated@1.0.0':
        resolution: {integrity: sha512-abc==}
        deprecated: |-
          Deprecated because of a bug: upgrade.
            Second line, indented further.
        peerDependencies:
          peer-thing: ^1.0.0
        peerDependenciesMeta:
          peer-thing:
            optional: true

    snapshots:

      tool@1.0.0: {}

      web-framework@2.0.0(peer-thing@1.0.0):
        dependencies:
          router: 1.1.0
          peer-thing: 1.0.0
        optionalDependencies:
          native-speedup: 1.0.0
        transitivePeerDependencies:
          - supports-color

      router@1.1.0:
        dependencies:
          web-framework: 2.0.0(peer-thing@1.0.0)

      peer-thing@1.0.0: {}

      native-speedup@1.0.0:
        optional: true

      test-only@3.0.0:
        dependencies:
          test-helper: 1.0.0

      test-helper@1.0.0: {}

      driver@4.0.0:
        dependencies:
          'it''s-quoted': 1.0.0

      'it''s-quoted@1.0.0': {}

      real-name@5.0.0: {}
    """
)


class ParseTest(unittest.TestCase):
    def test_reads_mappings_lists_quotes_and_block_scalars(self):
        data = pnpm_lock.parse(LOCK)
        self.assertEqual(data["lockfileVersion"], "9.0")
        self.assertEqual(data["settings"], {"autoInstallPeers": "true"})
        self.assertEqual(data["snapshots"]["tool@1.0.0"], {})
        self.assertEqual(
            data["snapshots"]["web-framework@2.0.0(peer-thing@1.0.0)"]["transitivePeerDependencies"],
            ["supports-color"],
        )
        package = data["packages"]["@scope/deprecated@1.0.0"]
        self.assertEqual(package["deprecated"], "Deprecated because of a bug: upgrade.\nSecond line, indented further.")
        self.assertEqual(package["peerDependenciesMeta"], {"peer-thing": {"optional": "true"}})
        self.assertIn("it's-quoted@1.0.0", data["snapshots"])

    def test_rejects_text_that_is_not_a_mapping(self):
        with self.assertRaises(ValueError):
            pnpm_lock.parse("key: value\n  - stray")
        with self.assertRaises(ValueError):
            pnpm_lock.parse("just words")

    def test_split_key(self):
        self.assertEqual(pnpm_lock.split_key("@a/b@1.0.0(peer@2.0.0)"), ("@a/b", "1.0.0"))
        self.assertEqual(pnpm_lock.split_key("plain@3.0.0"), ("plain", "3.0.0"))
        with self.assertRaises(ValueError):
            pnpm_lock.split_key("@scope-only")


class LockfileTest(unittest.TestCase):
    def setUp(self):
        self.lock = pnpm_lock.Lockfile(LOCK)

    def test_packages(self):
        self.assertIn(("web-framework", "2.0.0"), self.lock.packages())
        self.assertEqual(len(self.lock.packages()), 10)

    def test_production_closure_follows_links_and_skips_dev_dependencies(self):
        closure = self.lock.closure(["apps/server"])
        self.assertEqual(
            set(closure),
            {
                ("web-framework", "2.0.0"),
                ("router", "1.1.0"),
                ("peer-thing", "1.0.0"),
                ("native-speedup", "1.0.0"),
                ("driver", "4.0.0"),
                ("it's-quoted", "1.0.0"),
                ("real-name", "5.0.0"),
            },
        )
        self.assertEqual(closure[("it's-quoted", "1.0.0")], ["apps/server", "@riosoma/db", "driver", "it's-quoted"])
        self.assertEqual(closure[("real-name", "5.0.0")], ["apps/server", "@riosoma/db", "aliased"])

    def test_closure_with_every_section(self):
        closure = self.lock.closure(["apps/server"], pnpm_lock.ALL_SECTIONS)
        self.assertIn(("test-helper", "1.0.0"), closure)
        self.assertEqual(self.lock.closure(["missing"]), {})

    def test_platform_filter_matches_os_cpu_libc_and_exclusions(self):
        platforms = (("linux", "x64", "glibc"), ("linux", "arm64", "glibc"))
        cases = (
            ("os: [win32]", False),
            ("os: ['!linux']", False),
            ("cpu: [ia32]", False),
            ("cpu: [x64, '!x64']", False),
            ("libc: [musl]", False),
            ("os: [linux]\n    cpu: [x64]\n    libc: [glibc]", True),
            ("os: [linux]\n    cpu: [arm64]\n    libc: [glibc]", True),
            ("os:\n      - '!win32'\n    cpu:\n      - arm64", True),
            ("os: [any]", True),
        )
        for metadata, included in cases:
            with self.subTest(metadata=metadata):
                self.lock.packages_section = pnpm_lock.parse(f"packages:\n  native-speedup@1.0.0:\n    {metadata}")["packages"]
                closure = self.lock.closure(["apps/server"], platforms=platforms)
                self.assertEqual(("native-speedup", "1.0.0") in closure, included)
                self.assertIn(("driver", "4.0.0"), closure)
                self.assertIn(("native-speedup", "1.0.0"), self.lock.closure(["apps/server"]))

    def test_platform_filter_requires_one_platform_to_match_every_constraint(self):
        self.lock.packages_section["native-speedup@1.0.0"] = {"os": "[linux]", "cpu": "[arm64]"}
        closure = self.lock.closure(
            ["apps/server"], platforms=(("linux", "x64", "glibc"), ("darwin", "arm64", "glibc"))
        )
        self.assertNotIn(("native-speedup", "1.0.0"), closure)

    def test_excluded_peer_snapshot_does_not_bring_its_dependencies(self):
        self.lock.packages_section["web-framework@2.0.0"] = {"os": "[win32]"}
        closure = self.lock.closure(["apps/server"], platforms=(("linux", "x64", "glibc"),))
        self.assertNotIn(("web-framework", "2.0.0"), closure)
        self.assertNotIn(("router", "1.1.0"), closure)
        self.assertIn(("real-name", "5.0.0"), closure)

    def test_browser_filter_excludes_os_and_cpu_restrictions(self):
        for metadata, included in (({"os": "[linux]"}, False), ({"cpu": ["arm64"]}, False),
                                   ({"libc": "[glibc]"}, True), ({}, True)):
            with self.subTest(metadata=metadata):
                self.lock.packages_section["web-framework@2.0.0"] = metadata
                closure = self.lock.closure(["apps/server"], browser=True)
                self.assertEqual(("web-framework", "2.0.0") in closure, included)
                self.assertEqual(("router", "1.1.0") in closure, included)
                self.assertIn(("real-name", "5.0.0"), closure)

    def test_closure_of_one_dependency_excludes_itself(self):
        self.assertEqual(
            set(self.lock.closure_of_dependency("apps/server", "web-framework")),
            {("router", "1.1.0"), ("peer-thing", "1.0.0"), ("native-speedup", "1.0.0")},
        )
        self.assertEqual(
            set(self.lock.closure_of_dependency("apps/server", "@riosoma/db")),
            {("driver", "4.0.0"), ("it's-quoted", "1.0.0"), ("real-name", "5.0.0")},
        )
        self.assertEqual(self.lock.closure_of_dependency("apps/server", "absent"), {})

    def test_direct(self):
        self.assertEqual(self.lock.direct("apps/server", pnpm_lock.PROD_SECTIONS)["web-framework"], "2.0.0(peer-thing@1.0.0)")
        self.assertIn("test-only", self.lock.direct("apps/server"))

    def test_missing_file_reads_as_empty(self):
        with TemporaryDirectory() as directory:
            lock = pnpm_lock.Lockfile.read(Path(directory) / "pnpm-lock.yaml")
        self.assertEqual(lock.packages(), set())
        self.assertEqual(lock.importers, {})

    def test_reads_the_repository_lockfile(self):
        lock = pnpm_lock.Lockfile.read(Path(__file__).resolve().parents[2] / "pnpm-lock.yaml")
        self.assertIn("apps/server", lock.importers)
        self.assertTrue(lock.closure(["apps/server"]))


if __name__ == "__main__":
    unittest.main()
