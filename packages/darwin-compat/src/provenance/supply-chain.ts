/**
 * Supply-chain checks (REL-006).
 *
 * This is a small manifest audit, not a vulnerability database: install hooks,
 * insecure protocols, floating ranges, and the repository's explicit overrides.
 * Lockfile presence and frozen installs are checked by the script.
 */

export interface Manifest {
  readonly path: string;
  readonly json: {
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
    readonly optionalDependencies?: Record<string, string>;
    readonly scripts?: Record<string, string>;
    readonly overrides?: Record<string, string>;
  };
}

export interface SupplyChainFinding {
  readonly path: string;
  readonly rule: string;
  readonly message: string;
}

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;
const REQUIRED_OVERRIDES: Record<string, string> = {
  "serialize-javascript": "^7.1.3",
  tinypool: "^2.1.1",
  uuid: "^11.1.1",
};

export function auditManifests(manifests: readonly Manifest[]): SupplyChainFinding[] {
  const findings: SupplyChainFinding[] = [];
  const overrides = new Map<string, string>();
  for (const manifest of manifests) {
    for (const hook of INSTALL_HOOKS) {
      if (manifest.json.scripts?.[hook]) {
        findings.push({
          path: manifest.path,
          rule: "install-hook",
          message: `${hook} script is not allowed in workspace manifests`,
        });
      }
    }
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      for (const [name, range] of Object.entries(manifest.json[section] ?? {})) {
        if (/^(https?|git|file):/.test(range) && !range.startsWith("https://")) {
          findings.push({
            path: manifest.path,
            rule: "insecure-source",
            message: `${name} uses ${range}; only https/git+https sources are allowed`,
          });
        }
        if (range === "*" || range === "latest") {
          findings.push({
            path: manifest.path,
            rule: "floating-range",
            message: `${name} uses ${range}; pin a bounded range`,
          });
        }
      }
    }
    for (const [name, range] of Object.entries(manifest.json.overrides ?? {})) {
      overrides.set(name, range);
    }
  }
  for (const [name, expected] of Object.entries(REQUIRED_OVERRIDES)) {
    const actual = overrides.get(name);
    if (!actual) {
      findings.push({
        path: "package.json",
        rule: "missing-override",
        message: `override ${name} is missing`,
      });
    } else if (actual !== expected) {
      findings.push({
        path: "package.json",
        rule: "override-drift",
        message: `${name} override is ${actual}, expected ${expected}`,
      });
    }
  }
  return findings;
}

export function auditLockfile(text: string): SupplyChainFinding[] {
  const findings: SupplyChainFinding[] = [];
  if (!text.includes('"lockfileVersion"')) {
    findings.push({
      path: "bun.lock",
      rule: "lockfile-format",
      message: "lockfileVersion is missing",
    });
  }
  if (/\bgit\+http:\/\/|\bhttp:\/\//.test(text)) {
    findings.push({
      path: "bun.lock",
      rule: "insecure-source",
      message: "lockfile contains an insecure http/git URL",
    });
  }
  return findings;
}
