// Bug 409: ports web browsers and Node's fetch refuse to connect to (the Fetch standard's "bad port" list, which Chromium's net/base/port_util.cc
// kRestrictedPorts and Node's undici both follow). fetch('http://localhost:6000/') throws "bad port" without trying, so HQ never hands out one of these:
// an app it put there would be one no browser opens and HQ's own fetch never sees answer. A port the user's recipe hard-wires may still be one; HQ's preview
// probe uses node:http, which has no such list. Matches Node 25.4's fetch on every port 1–65535; badports.test.ts checks it against fetch. No imports.

/** The Fetch standard's bad ports, as Node's fetch refuses them. */
export const BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])
/** Would a browser (and Node's fetch) refuse this port? */
export const badPort = (port: number): boolean => BAD_PORTS.has(port)
