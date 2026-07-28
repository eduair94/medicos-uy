export interface SourceUrlPolicy {
  readonly assertAllowed: (value: string) => URL;
  readonly isAllowed: (value: string) => boolean;
}

function isBlockedIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    isBlockedIpv4(normalized) ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  );
}

export function createSourceUrlPolicy(options: {
  readonly allowedHostnames: readonly string[];
}): SourceUrlPolicy {
  const allowlist = new Set(
    options.allowedHostnames.map((hostname) =>
      hostname
        .toLowerCase()
        .replace(/^\[|\]$/gu, '')
        .replace(/\.$/, ''),
    ),
  );
  if (allowlist.size === 0 || [...allowlist].some(isBlockedHostname)) {
    throw new Error('Source URL policy requires at least one public hostname');
  }

  const assertAllowed = (value: string): URL => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Source URL must be absolute');
    }
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, '')
      .replace(/\.$/, '');
    const hostAllowed = [...allowlist].some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    );
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.port.length > 0 && url.port !== '443') ||
      isBlockedHostname(hostname) ||
      !hostAllowed
    ) {
      throw new Error(`Source URL is outside the approved public HTTPS allowlist: ${hostname}`);
    }
    url.hash = '';
    return url;
  };

  return {
    assertAllowed,
    isAllowed(value: string): boolean {
      try {
        assertAllowed(value);
        return true;
      } catch {
        return false;
      }
    },
  };
}
