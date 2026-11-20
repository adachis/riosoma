/**
 * The pinned archives drivers install from, with each one's integrity hash and the size its files
 * take once unpacked, so an install can check for room first.  An npm archive carries the registry's
 * own `sha512-` hash and the unpacked size the registry records.  IBM publishes no hash for its
 * client, so each client archive carries the SHA-256 of IBM's official download, taken when it was
 * pinned, and the size its files take here, counting each link inside it as the copy it becomes.
 */
export const artifacts = [
  {
    id: 'teradatasql',
    version: '20.0.69',
    url: 'https://registry.npmjs.org/teradatasql/-/teradatasql-20.0.69.tgz',
    integrity:
      'sha512-RJcISMXMwCcmXFOAh0cD79UpZrrWDKZFoHHzPQLnN2NU3aNeBA99M00dNe3XLnIu0aZ98i44umPu2EKSufXuOA==',
    unpackedSize: 206_225_485,
    target: 'package',
    root: 'package',
  },
  {
    id: 'koffi',
    version: '2.14.1',
    url: 'https://registry.npmjs.org/koffi/-/koffi-2.14.1.tgz',
    integrity:
      'sha512-IMFL3IbRDXacSIjs7pPbPxgNlJ2hUtawQXU2QPdr6iw38jmv5AesAUG8HPX00xl0PPA2BbEa3noTw1YdHY+gHg==',
    unpackedSize: 86_185_395,
    target: 'package/node_modules/koffi',
    root: 'package',
  },
  {
    id: 'ibm_db',
    version: '4.0.1',
    url: 'https://registry.npmjs.org/ibm_db/-/ibm_db-4.0.1.tgz',
    integrity:
      'sha512-0fO1fyaDm3jqaydObwKZw1aUNh6SbfHKxtrSfadWHoFsrnmBhQfp1oMFm6cWJSRNjE9pHyQw7zUNteuLRObwSg==',
    unpackedSize: 5_379_185,
    target: 'package',
    root: 'package',
  },
  {
    id: 'bindings',
    version: '1.5.0',
    url: 'https://registry.npmjs.org/bindings/-/bindings-1.5.0.tgz',
    integrity:
      'sha512-p2q/t/mhvuOj/UeLlV6566GD/guowlr0hHxClI0W9m7MWYkL1F0hLo+0Aexs9HSPCtR1SXQ0TD3MMKrXZajbiQ==',
    unpackedSize: 11_230,
    target: 'package/node_modules/bindings',
    root: 'package',
  },
  {
    id: 'file-uri-to-path',
    version: '1.0.0',
    url: 'https://registry.npmjs.org/file-uri-to-path/-/file-uri-to-path-1.0.0.tgz',
    integrity:
      'sha512-0Zt+s3L7Vf1biwWZ29aARiVYLx7iMGnEUl9x33fbB/j3jR81u/O2LbqK+Bm1CDSNDKVtJ/YjwY7TUd5SkeLQLw==',
    // The registry records no unpacked size for this release, so this is a generous bound.
    unpackedSize: 65_536,
    target: 'package/node_modules/file-uri-to-path',
    root: 'package',
  },
  {
    id: 'big-integer',
    version: '1.6.52',
    url: 'https://registry.npmjs.org/big-integer/-/big-integer-1.6.52.tgz',
    integrity:
      'sha512-QxD8cf2eVqJOOz63z6JIN9BzvVs/dlySa5HGSBH5xtR8dPteIRQnBxxKqkNTiT6jbDTF6jAfrd4oMcND9RGbQg==',
    unpackedSize: 175_004,
    target: 'package/node_modules/big-integer',
    root: 'package',
  },
  {
    // SHA-256 77b754d19be2cd5c55f6feb8bd951c2b17aa6646289944855612c5a2ac555f55
    id: 'clidriver-linux-x64',
    version: '12.1.4',
    url: 'https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/v12.1.4/linuxx64_odbc_cli.tar.gz',
    integrity: 'sha256-d7dU0ZvizVxV9v64vZUcKxeqZkYomUSFVhLFoqxVX1U=',
    unpackedSize: 124_616_044,
    target: 'package/installer/clidriver',
    root: 'clidriver',
    platforms: ['linux-x64'],
    links: 'copy',
  },
  {
    // SHA-256 188adacc6a6efd2381f5315bac16b42f0c719ea8c2fce0a1f7a8950e68f84011
    id: 'clidriver-darwin-arm64',
    version: '12.1.4',
    url: 'https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/v12.1.4/macarm64_odbc_cli.tar.gz',
    integrity: 'sha256-GIrazGpu/SOB9TFbrBa0LwxxnqjC/OCh96iVDmj4QBE=',
    unpackedSize: 60_945_039,
    target: 'package/installer/clidriver',
    root: 'clidriver',
    platforms: ['darwin-arm64'],
    links: 'copy',
  },
] as const;
