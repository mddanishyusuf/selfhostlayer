// MongoDB, from MongoDB's own apt repository (it isn't in Ubuntu's or Debian's):
// the signing key, the source line, and the settings the agent writes.

export const MONGODB_SERIES = "9.0";

/**
 * "MongoDB 9 Release Signing Key <packaging@mongodb.com>", fingerprint
 * B3B42B6C39E5CDDEC0A27E3CF366D55B602E502D: the key that signs the 9.0
 * repository's InRelease. From https://pgp.mongodb.com/server-9.asc (the same
 * key is on keyserver.ubuntu.com). Shipped with the agent, so installing never
 * trusts a key fetched at that moment.
 */
export const MONGODB_SIGNING_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

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
fqdDE+7nkBIPEZgUfrrPRs0=
=uvKw
-----END PGP PUBLIC KEY BLOCK-----
`;

export const MONGODB_KEYRING = "/etc/apt/keyrings/mongodb-server-9.asc";
export const MONGODB_SOURCES = `/etc/apt/sources.list.d/mongodb-org-${MONGODB_SERIES}.list`;
/** mongod's settings. The package's own /etc/mongod.conf stays untouched, so upgrades never ask about it. */
export const MONGOD_CONF = "/etc/mongodb-layer.conf";
export const MONGOSH_CONF = "/etc/mongosh.conf";

const UBUNTU = ["noble", "resolute"];
const DEBIAN = ["bookworm", "trixie"];

/**
 * The apt source for this OS (/etc/os-release ID and VERSION_CODENAME) and CPU,
 * or why there's none. MongoDB builds server packages for Ubuntu on x86 and
 * ARM, but for Debian only on x86.
 */
export function mongodbSource(id: string, codename: string, arch: string): { line: string } | { error: string } {
  const debArch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!debArch) return { error: `MongoDB has no packages for ${arch} CPUs` };
  if (id === "ubuntu" && UBUNTU.includes(codename)) {
    return { line: `deb [ arch=${debArch} signed-by=${MONGODB_KEYRING} ] https://repo.mongodb.org/apt/ubuntu ${codename}/mongodb-org/${MONGODB_SERIES} multiverse` };
  }
  if (id === "debian" && DEBIAN.includes(codename)) {
    if (debArch !== "amd64") return { error: "MongoDB has no ARM packages for Debian; on an ARM server, use Ubuntu 24.04 or 26.04" };
    return { line: `deb [ arch=amd64 signed-by=${MONGODB_KEYRING} ] https://repo.mongodb.org/apt/debian ${codename}/mongodb-org/${MONGODB_SERIES} main` };
  }
  return { error: `MongoDB ${MONGODB_SERIES} has no packages for ${id || "this OS"} ${codename}` };
}

/**
 * Settings for a small box, like Postgres's and MariaDB's: 127.0.0.1 only,
 * logins required, a WiredTiger cache of 1/16 of RAM (0.25–1 GB; MongoDB's own
 * default is half of RAM minus 1 GB), logs to the journal, and no diagnostic
 * data collection filling the disk.
 */
export function renderMongodConf(totalMb: number): string {
  const cacheGb = Math.min(1, Math.max(0.25, Math.round((totalMb / 16 / 1024) * 100) / 100));
  return `# Generated by layer-agent: MongoDB tuned for a small server.
storage:
  dbPath: /var/lib/mongodb
  wiredTiger:
    engineConfig:
      cacheSizeGB: ${cacheGb}
systemLog:
  destination: syslog
net:
  port: 27017
  bindIp: 127.0.0.1
  maxIncomingConnections: 200
security:
  authorization: enabled
setParameter:
  diagnosticDataCollectionEnabled: false
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
`;
}

/**
 * A drop-in for the package's mongod.service: our settings file, back up after
 * a crash (but not forever), and the memory allocator without per-CPU caches.
 *
 * MongoDB 9.0 won't start on Linux 6.19.0 to 7.0.13, whose rseq changes break
 * those caches (SERVER-121912), and every Ubuntu 26.04 kernel calls itself
 * 7.0.0. The package's unit hands rseq to the allocator (rseq=0); left with
 * glibc, the allocator keeps per-thread caches instead, as MongoDB did up to
 * 7.0, and MongoDB starts on any kernel. Set everywhere, so a kernel update
 * can't stop MongoDB at the next reboot.
 */
export function renderMongodDropin(): string {
  return `# Generated by layer-agent.
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart=
ExecStart=/usr/bin/mongod --config ${MONGOD_CONF}
# Per-thread allocator caches: with per-CPU ones, MongoDB refuses kernels 6.19.0 to 7.0.13.
Environment=GLIBC_TUNABLES=glibc.pthread.rseq=1
Restart=on-failure
RestartSec=5
`;
}

/** mongosh sends usage data to MongoDB unless told not to. */
export function renderMongoshConf(): string {
  return `# Generated by layer-agent.
mongosh:
  enableTelemetry: false
`;
}
