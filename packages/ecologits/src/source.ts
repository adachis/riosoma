// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.  If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where the port and its data come from.  The data files are unchanged copies of the release's
 * own, and a test checks them against these digests, so a copy can't drift from its source
 * unnoticed.
 */
export const SOURCE = Object.freeze({
  project: 'EcoLogits',
  repository: 'https://github.com/genai-impact/ecologits',
  license: 'MPL-2.0',
  version: '0.11.1',
  /** The commit the release tag points at */
  commit: '886d1ebfadb51a2d6407fcea6d9778c997c85c35',
  files: Object.freeze({
    'data/models.json': Object.freeze({
      from: 'ecologits/data/models.json',
      sha256: 'd02e621cfc0006610a4b144aa8888f1de878c57b15b4c63d21d95a9879bbaf5d',
    }),
    'data/electricity_mixes.json': Object.freeze({
      from: 'ecologits/data/electricity_mixes.json',
      sha256: '993c9b4bc8aede3e8aa6a32af9dbe705a8a7d22d495c4ae36fe5861ff931394f',
    }),
  }),
});

/** The method an estimate follows, recorded beside every estimate so totals can say which. */
export const METHOD_VERSION = `${SOURCE.project} ${SOURCE.version}`;
