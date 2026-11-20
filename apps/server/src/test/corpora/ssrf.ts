/** Synthetic destinations shared by every network boundary. */
export const privateUrls = [
  'https://127.1/',
  'https://2130706433/',
  'https://0x7f000001/',
  'https://0177.0.0.1/',
  'https://%31%32%37.0.0.1/',
  'https://[::1]/',
  'https://[::ffff:127.0.0.1]/',
  'https://[::ffff:0.0.0.0]/',
  'https://[64:ff9b::a00:1]/',
  'https://[2002:0a00:0001::]/',
  'https://10.0.0.1/',
  'https://172.16.0.1/',
  'https://192.168.0.1/',
  'https://169.254.169.254/latest/meta-data/',
  'https://100.64.0.1/',
  'https://0.0.0.0/',
  'https://[fc00::1]/',
  'https://[fe80::1]/',
] as const;

export const publicAddress = { address: '93.184.216.34', family: 4 as const };
export const privateAddresses = privateUrls.map((value) => {
  const address = new URL(value).hostname.replace(/^\[(.*)\]$/, '$1');
  return { address, family: address.includes(':') ? (6 as const) : (4 as const) };
});
