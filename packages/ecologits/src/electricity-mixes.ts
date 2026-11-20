// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.  If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Ported from EcoLogits 0.11.1 (https://github.com/genai-impact/ecologits), by Samuel Rincé,
// Adrien Banse, and the GenAI Impact contributors: ecologits/electricity_mix_repository.py.

import data from './data/electricity_mixes.json' with { type: 'json' };

/** The impact factors of one zone's electricity. */
export interface ElectricityMix {
  /** ISO 3166-1 alpha-3 code, or `WOR` for the world and `EEE` for Europe */
  zone: string;
  /** kgSbeq per kWh */
  adpe: number;
  /** MJ per kWh */
  pe: number;
  /** kgCO2eq per kWh */
  gwp: number;
  /** Liters per kWh */
  wue: number;
  /** Codes such as `electricity-mix-pe-world`, for factors that fall back to the world's */
  warnings: string[];
}

interface RawMix {
  name: string;
  adpe: number | string;
  pe: number | string;
  gwp: number | string;
  wue: number | string;
  warnings?: string[] | null;
}

function repository(): Map<string, ElectricityMix> {
  const file = data as unknown as { electricity_mixes?: RawMix[] | null };
  const mixes = new Map<string, ElectricityMix>();
  for (const raw of file.electricity_mixes ?? []) {
    if (mixes.has(raw.name)) throw new Error(`duplicated electricity mix with: ${raw.name}`);
    mixes.set(raw.name, {
      zone: raw.name,
      adpe: Number(raw.adpe),
      pe: Number(raw.pe),
      gwp: Number(raw.gwp),
      wue: Number(raw.wue),
      warnings: raw.warnings ?? [],
    });
  }
  if (mixes.size === 0) throw new Error('Cannot initialize on an empty electricity mix repository.');
  return mixes;
}

const MIXES = repository();

export function findElectricityMix(zone: string): ElectricityMix | null {
  return MIXES.get(zone) ?? null;
}

/** Every zone with an electricity mix, in the data's order. */
export const ELECTRICITY_ZONES: readonly string[] = Object.freeze([...MIXES.keys()]);

/** Whether a zone has an electricity mix in the method's data. */
export function isElectricityZone(zone: string): boolean {
  return MIXES.has(zone);
}
