from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import textwrap
import tomllib
import unittest

import check_dependencies as checker


LOCK = textwrap.dedent(
    """\
    importers:
      .:
        devDependencies:
          typescript:
            specifier: 6.0.0
            version: 6.0.0
    packages:
      editor@1.0.0:
        resolution: {integrity: sha512-a==}
        peerDependencies:
          editor-core: ^1.0.0
          editor-extras: ^1.0.0
        peerDependenciesMeta:
          editor-extras:
            optional: true
    """
)


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.write("pnpm-lock.yaml", LOCK)
        self.manifest(".", devDependencies={"typescript": "6.0.0"}, scripts={"typecheck": "tsc -b"})
        self.install_bin("typescript", {"tsc": "bin/tsc"})

    def tearDown(self):
        self.directory.cleanup()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def manifest(self, directory, **fields):
        self.write(f"{directory}/package.json", json.dumps({"name": directory, **fields}))

    def install_bin(self, name, bins):
        self.write(f"node_modules/{name}/package.json", json.dumps({"name": name, "bin": bins}))

    def files(self):
        return [
            p.relative_to(self.root)
            for p in self.root.rglob("*")
            if p.is_file() and "node_modules" not in p.parts
        ]

    def check(self, reasons):
        return checker.check(self.root, tomllib.loads(textwrap.dedent(reasons)), self.files())

    def test_clean_repository(self):
        self.manifest("apps/web", dependencies={"react": "19.0.0", "@riosoma/ui": "workspace:*"})
        self.write("apps/web/src/main.ts", "import { createRoot } from 'react';\nimport '@riosoma/ui';\n")
        errors = self.check(
            """
            ["."]
            typescript = "Compiles the code."
            ["apps/web"]
            react = "The UI library."
            """
        )
        self.assertEqual(errors, [])

    def test_missing_reason_fails(self):
        self.manifest("apps/web", dependencies={"react": "19.0.0"})
        self.write("apps/web/src/main.ts", "import 'react';")
        errors = self.check('["."]\ntypescript = "Compiles."')
        self.assertEqual(errors, ["apps/web: react has no reason in dependency-reasons.toml"])

    def test_workspace_dependencies_need_no_reason_but_must_be_used(self):
        self.manifest("apps/web", dependencies={"@riosoma/ui": "workspace:*"})
        errors = self.check('["."]\ntypescript = "Compiles."')
        self.assertEqual(len(errors), 1)
        self.assertIn("@riosoma/ui is declared but never used", errors[0])

    def test_stale_entries_and_unknown_packages_fail(self):
        errors = self.check(
            """
            ["."]
            typescript = "Compiles."
            left-pad = "Pads strings."
            ["apps/gone"]
            thing = "Was here."
            """
        )
        self.assertIn('dependency-reasons.toml: ["apps/gone"] is not a package with a package.json', errors)
        self.assertIn(".: dependency-reasons.toml lists left-pad, which package.json no longer declares", errors)

    def test_invalid_entries_fail(self):
        for entry in ('""', "3", '{ unseen = "Loaded by name." }', '{ reason = "R", unseen = "" }', '{ reason = "R", extra = "x" }'):
            with self.subTest(entry=entry):
                errors = self.check(f'["."]\ntypescript = {entry}')
                self.assertTrue(any("needs a nonempty reason" in e for e in errors), errors)

    def test_unused_dependency_fails_and_unseen_use_passes(self):
        self.manifest("apps/server", dependencies={"pretty-logs": "1.0.0"})
        self.write("apps/server/src/logger.ts", "const target = ['pretty', 'logs'].join('-');")
        errors = self.check('["."]\ntypescript = "Compiles."\n["apps/server"]\npretty-logs = "Readable logs."')
        self.assertEqual(
            errors,
            [
                "apps/server: pretty-logs is declared but never used; remove it, or explain an unseen use in "
                "dependency-reasons.toml"
            ],
        )
        errors = self.check(
            '["."]\ntypescript = "Compiles."\n["apps/server"]\n'
            'pretty-logs = { reason = "Readable logs.", unseen = "Loaded by a computed name in logger.ts." }'
        )
        self.assertEqual(errors, [])

    def test_a_dependency_used_only_in_another_package_is_unused(self):
        self.manifest("apps/web", dependencies={"react": "19.0.0"})
        self.manifest("apps/server", dependencies={})
        self.write("apps/server/src/main.ts", "import 'react';")
        errors = self.check('["."]\ntypescript = "Compiles."\n["apps/web"]\nreact = "UI."')
        self.assertEqual(len(errors), 1)
        self.assertIn("apps/web: react is declared but never used", errors[0])

    def test_root_dependencies_serve_the_whole_repository(self):
        self.manifest(".", devDependencies={"typescript": "6.0.0", "prettier": "3.0.0", "linter": "1.0.0"})
        self.write("tools/format.mjs", "import { format } from 'prettier';")
        self.write(".github/workflows/ci.yml", "steps:\n  - run: pnpm exec linter --fix .\n")
        self.manifest("packages/ui", scripts={"typecheck": "tsc -p tsconfig.json"})
        errors = self.check('["."]\ntypescript = "Compiles."\nprettier = "Formats."\nlinter = "Lints."')
        self.assertEqual(errors, [])

    def test_commands_come_from_installed_manifests_or_the_package_name(self):
        self.manifest("packages/db", devDependencies={"typescript": "6.0.0", "migrator": "1.0.0"}, scripts={
            "build": "tsc -p tsconfig.build.json",
            "migrate": "migrator up && echo done",
        })
        errors = self.check('["."]\ntypescript = "C."\n["packages/db"]\ntypescript = "C."\nmigrator = "M."')
        self.assertEqual(errors, [])
        # A word inside another word is not a command.
        self.manifest("packages/db", devDependencies={"migrator": "1.0.0"}, scripts={"x": "run-migrator-now"})
        errors = self.check('["."]\ntypescript = "C."\n["packages/db"]\nmigrator = "M."')
        self.assertEqual(len(errors), 1)

    def test_types_packages_follow_what_they_describe(self):
        self.manifest(
            "packages/db",
            dependencies={"pg": "8.0.0", "@scope/tool": "1.0.0"},
            devDependencies={"@types/pg": "8.0.0", "@types/scope__tool": "1.0.0", "@types/node": "24.0.0",
                             "@types/unused": "1.0.0"},
        )
        self.write("packages/db/src/db.ts", "import pg from 'pg';\nimport { x } from '@scope/tool';\nimport 'node:fs';")
        errors = self.check(
            """
            ["."]
            typescript = "C."
            ["packages/db"]
            pg = "Driver."
            "@scope/tool" = "Tool."
            "@types/pg" = "Types."
            "@types/scope__tool" = "Types."
            "@types/node" = "Types."
            "@types/unused" = "Types."
            """
        )
        self.assertEqual(len(errors), 1)
        self.assertIn("@types/unused is declared but never used", errors[0])

    def test_tsconfig_types_count_as_use(self):
        self.manifest("apps/hub", devDependencies={"@cloud/workers-types": "1.0.0", "@types/node": "24.0.0"})
        self.write("apps/hub/tsconfig.json", '{"compilerOptions": {"types": ["@cloud/workers-types", "node"]}}')
        errors = self.check('["."]\ntypescript = "C."\n["apps/hub"]\n"@cloud/workers-types" = "T."\n"@types/node" = "T."')
        self.assertEqual(errors, [])

    def test_jsx_files_use_react(self):
        self.manifest("packages/icons", dependencies={"react": "19.0.0"}, devDependencies={"@types/react": "19.0.0"})
        self.write("packages/icons/src/Icon.tsx", "export const Icon = () => <svg />;")
        errors = self.check('["."]\ntypescript = "C."\n["packages/icons"]\nreact = "R."\n"@types/react" = "T."')
        self.assertEqual(errors, [])

    def test_required_peers_of_used_packages_count_as_used(self):
        self.manifest("apps/web", dependencies={"editor": "1.0.0", "editor-core": "1.0.0", "editor-extras": "1.0.0"})
        self.write("apps/web/src/editor.ts", "import { Editor } from 'editor';")
        errors = self.check('["."]\ntypescript = "C."\n["apps/web"]\neditor = "E."\neditor-core = "P."\neditor-extras = "O."')
        # editor-core is a required peer, but editor-extras is optional, so it must be used or explained.
        self.assertEqual(len(errors), 1)
        self.assertIn("editor-extras is declared but never used", errors[0])

    def test_css_imports_and_config_strings_count(self):
        self.manifest("apps/web", dependencies={"@fontsource/inter": "5.0.0", "plugin": "1.0.0"})
        self.write("apps/web/src/fonts.css", "@import '@fontsource/inter/400.css';")
        self.write("apps/web/vite.config.ts", "export default { plugins: [['plugin', {}]] };")
        errors = self.check('["."]\ntypescript = "C."\n["apps/web"]\n"@fontsource/inter" = "F."\nplugin = "P."')
        self.assertEqual(errors, [])

    def test_dependency_sections_of_manifests_do_not_count_as_use(self):
        self.manifest("apps/web", dependencies={"react": "19.0.0"}, peerDependencies={"react": "^19"})
        errors = self.check('["."]\ntypescript = "C."\n["apps/web"]\nreact = "R."')
        self.assertEqual(len(errors), 1)

    def test_skips_build_output_and_installed_packages(self):
        self.manifest("apps/web", dependencies={"react": "19.0.0"})
        self.write("apps/web/dist/main.js", "import 'react';")
        self.write("apps/web/node_modules/x/index.js", "import 'react';")
        files = checker.listed_files(self.root)
        self.assertFalse(any("dist" in p.parts or "node_modules" in p.parts for p in files))
        errors = checker.check(self.root, {".": {"typescript": "C."}, "apps/web": {"react": "R."}})
        self.assertEqual(len(errors), 1)

    def test_main_reads_the_file_and_sets_the_exit_status(self):
        self.write("dependency-reasons.toml", '["."]\ntypescript = "Compiles."\n')
        output = StringIO()
        with redirect_stdout(output):
            self.assertEqual(checker.main(self.root), 0)
        self.assertIn("Every direct dependency is used", output.getvalue())
        self.write("dependency-reasons.toml", "broken = [")
        output = StringIO()
        with redirect_stdout(output):
            self.assertEqual(checker.main(self.root), 1)
        self.assertIn("::error::Cannot read dependency-reasons.toml", output.getvalue())

    def test_types_target(self):
        self.assertEqual(checker.types_target("@types/node"), "node")
        self.assertEqual(checker.types_target("@types/babel__core"), "@babel/core")


if __name__ == "__main__":
    unittest.main()
