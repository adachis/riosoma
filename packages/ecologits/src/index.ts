// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.  If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A TypeScript port of EcoLogits 0.11.1's estimate for text generation requests: energy from the
 * model's active parameters and the output tokens, by the method's GPU benchmark regressions, the
 * data center's PUE, the server and GPU embodied impacts, and the electricity mix of a zone for
 * GWP, ADPe, and PE.  Everything else in Riosoma uses only what this file exports.
 */
export {
  estimate,
  hasModel,
  type Estimate,
  type EstimateRequest,
  type EstimateResult,
  type NoEstimate,
} from './estimate.js';
export { ELECTRICITY_ZONES, findElectricityMix, isElectricityZone } from './electricity-mixes.js';
export { PROVIDERS, type Provider } from './models.js';
export type { Range } from './range.js';
export { METHOD_VERSION, SOURCE } from './source.js';
