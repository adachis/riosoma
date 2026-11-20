#!/usr/bin/env python3
"""Computes the reference values the EcoLogits port's tests compare against.

Runs the original Python package over the cases in packages/ecologits/fixtures/matrix.json and
writes what it answers to packages/ecologits/fixtures/reference.json.  The port has to match each
figure within 1%.

Use a virtual environment outside the checkout, holding the release the port follows, never the
system's Python:

    python3 -m venv "$VENV"
    "$VENV/bin/pip" install ecologits==0.11.1
    "$VENV/bin/python" tools/ecologits_reference.py

It refuses to run against any other release, since the fixture would then describe a different
method than the one the port copies.
"""
import itertools
import json
import math
import platform
import sys
from importlib.metadata import version
from pathlib import Path

EXPECTED_VERSION = '0.11.1'
ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / 'packages' / 'ecologits' / 'fixtures'


def bounds(value):
    """A value as a low and a high end, the way the port reports every figure."""
    if hasattr(value, 'min'):
        return {'min': value.min, 'max': value.max}
    return {'min': value, 'max': value}


def answer(llm_impacts, provider, model, output_tokens, zone, latency):
    impacts = llm_impacts(
        provider=provider,
        model_name=model,
        output_token_count=output_tokens,
        request_latency=math.inf if latency is None else latency,
        electricity_mix_zone=zone,
    )
    if impacts.has_errors:
        return {'error': impacts.errors[0].code}
    return {
        'energyKwh': bounds(impacts.energy.value),
        'gwpKgCo2eq': bounds(impacts.gwp.value),
        'adpeKgSbEq': bounds(impacts.adpe.value),
        'peMj': bounds(impacts.pe.value),
        'warnings': [warning.code for warning in impacts.warnings or []],
    }


def main():
    installed = version('ecologits')
    if installed != EXPECTED_VERSION:
        sys.exit(f'ecologits {installed} is installed, and the port follows {EXPECTED_VERSION}.')
    from ecologits.tracers.utils import llm_impacts

    matrix = json.loads((FIXTURES / 'matrix.json').read_text())
    cases = []
    for entry, tokens, zone in itertools.product(matrix['models'], matrix['outputTokens'], matrix['zones']):
        cases.append((entry['provider'], entry['model'], tokens, zone, None))
    for entry, latency in itertools.product(matrix['models'], matrix['requestLatencySeconds']):
        cases.append((entry['provider'], entry['model'], 1000, 'WOR', latency))
    for entry in matrix['unknown']:
        cases.append((entry['provider'], entry['model'], 1000, entry['zone'], None))

    results = []
    for provider, model, tokens, zone, latency in cases:
        results.append({
            'provider': provider,
            'model': model,
            'outputTokens': tokens,
            'zone': zone,
            'requestLatencySeconds': latency,
            'result': answer(llm_impacts, provider, model, tokens, zone, latency),
        })
    header = {
        'generatedBy': 'tools/ecologits_reference.py',
        'ecologits': installed,
        'python': platform.python_version(),
    }
    # One case to a line keeps the file small and its diffs readable.
    lines = [json.dumps(case, separators=(',', ':')) for case in results]
    text = json.dumps(header, indent=1)[:-2] + ',\n "cases": [\n  ' + ',\n  '.join(lines) + '\n ]\n}\n'
    json.loads(text)
    (FIXTURES / 'reference.json').write_text(text)
    print(f'Wrote {len(results)} cases from ecologits {installed}.')


if __name__ == '__main__':
    main()
