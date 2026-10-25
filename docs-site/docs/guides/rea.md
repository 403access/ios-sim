---

title: REA setup and use
sidebar_position: 6
description: How REA was installed, how it was used for the Mach-O evidence, and how to reproduce it.
---

# REA setup and use

[REA](https://github.com/morluto/rea) ("Reverse Engineer Anything") is an MCP server and CLI for
inspecting native binaries, apps, and runtime behaviour. It was used in this project to produce
evidence about the simulator's dependencies without opening a GUI disassembler.

## 1. What was installed

| Item                 | Version / location                                             |
| -------------------- | -------------------------------------------------------------- |
| Node.js              | 24.22.1 (REA requires 22.23.4+, 24.22.1+, or 26.12.1+)         |
| `rea-agents`         | 6.8.0 (via `npx`)                                              |
| MCP registration     | `~/.config/opencode/opencode.jsonc` → `mcp.rea`                |
| Agent skill          | `~/.agents/skills/reverse-engineer-anything`                   |
| Static Mach-O engine | Built in; no Hopper/Ghidra required for `inspect-macho`        |
| Optional engines     | Hopper, Ghidra 12.1.x, IDA MCP, JADX, Kuna — **not installed** |

The setup command used:

```bash
nvm install 24.22.1
nvm use 24.22.1
npx -y rea-agents@latest setup --yes --client opencode
npx -y rea-agents@latest doctor --client opencode
```

`doctor` reported the OpenCode registration healthy. It also reported the optional native
analysis providers as missing; that is expected and does not block static Mach-O inspection.

:::note Node version
REA initially refused to register with Node 24.10.0 because it was below the supported patch
level. Installing 24.22.1 fixed it. If `rea doctor` complains about the runtime, check the
engine requirements before debugging anything else.
:::

## 2. MCP configuration

The setup writes a registration equivalent to:

```jsonc
{
  "mcp": {
    "rea": {
      "type": "local",
      "command": ["npx", "-y", "rea-agents@6.8.0", "mcp"],
      "enabled": true
    }
  }
}
```

Restart the agent after changing MCP configuration. In OpenCode, the REA tools appear under the
`rea` server and the `reverse-engineer-anything` skill becomes available.

## 3. Commands used in this research

### Mach-O summary

```bash
npx -y rea-agents@latest inspect-macho \
  /Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit \
  --format json
```

Returns architecture, load commands, dependencies, imports/exports (paged), segments, build
metadata, and provenance. For large frameworks, request a summary first and page the collections.

### Dependency list

Use the MCP tool `inspect_analysis_view` with:

```jsonc
{
  "source": { "kind": "retained-evidence", "evidence_id": "ev_…" },
  "view": { "kind": "macho", "facet": "dependencies", "offset": 0, "limit": 64 }
}
```

### Imports (filtered)

Request the imports facet with a page limit, then filter locally for `mach_`, `xpc_`, `IOHID`,
`CGEvent`, `dyld`, and `posix_spawn`. This is how the Mach/XPC surface of `launchd_sim` was
identified.

## 4. Findings produced with REA

| Artifact                 | Key evidence                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SimulatorKit` (arm64e)  | 35 dependencies incl. QuartzCore, AppKit, Metal, IOSurface, IOKit, CoreSimulator; 767 imports incl. `CGEventCopyIOHIDEvent`, `IOHIDEventSystemClient*`, `CFMachPort*` |
| `CoreSimulator` (arm64e) | 34 dependencies incl. `CoreSimDeviceIO`, `ROCKit`, `ServiceManagement`, `MobileGestalt`, `libRosetta`, `swiftXPC`                                                     |
| `launchd_sim` (arm64)    | Mach ports, XPC, Darwin `posix_spawn` attributes, `dyld` shared-cache UUID                                                                                            |

The full interpretation is in [Findings §3](../research/findings.md#3-the-dependency-surface).
The raw hashes are in [References](../research/references.md#local-evidence).

## 5. What REA did not do

- It did not execute Apple binaries or bypass code signing.
- It did not decompile private frameworks to extract algorithms; the research only needed
  structural dependency facts.
- It did not upload anything: analysis is local.
- It did not prove that a symbol is absent. Mach-O inspection combines `dyld_info` and `nm`;
  stripped symbols may be missing, and paged results are not an exhaustive proof.

## 6. Optional deep analysis engines

If you want function-level analysis, configure one provider:

| Provider | Setup                                                                      |
| -------- | -------------------------------------------------------------------------- |
| Ghidra   | Install Ghidra 12.1.x and set `GHIDRA_INSTALL_DIR`                         |
| Hopper   | Install Hopper and set `HOPPER_LAUNCHER_PATH` (or approve setup's install) |
| IDA      | Set `REA_IDA_MCP_CONFIG` to a working IDA MCP registration                 |
| JADX     | Set `REA_JADX_MCP_JAR` for Android                                         |
| Kuna     | Set `REA_KUNA_COMMAND`                                                     |

Run `rea doctor` after configuring. Licensing for Hopper/IDA is your responsibility; REA does not
provide keys or licences.

## 7. Reproducing the evidence

```bash
# 1. Confirm the toolchain
node -v
npx -y rea-agents@latest doctor

# 2. Inspect the framework
npx -y rea-agents@latest inspect-macho \
  /Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit \
  --format json > simulator-kit.json

# 3. Inspect the lifecycle service
npx -y rea-agents@latest inspect-macho \
  /Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator \
  --format json > core-simulator.json

# 4. Inspect the runtime init
RUNTIME="/Library/Developer/CoreSimulator/Volumes/iOS_23E254a/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime"
npx -y rea-agents@latest inspect-macho "$RUNTIME/Contents/Resources/RuntimeRoot/sbin/launchd_sim" \
  --format json > launchd-sim.json
```

Exact volume paths differ by installed runtime; use `find /Library/Developer/CoreSimulator/Volumes
-name launchd_sim` to locate yours.

## 8. Ethics and limits

REA's own disclaimer applies: use it for lawful research, education, interoperability, and
software you own or are authorised to examine. In this project it was used on the local Xcode
installation to answer an interoperability question. Do not use it to circumvent licensing,
extract redistributable Apple code, or analyse software without permission.

## 9. Why REA instead of a manual `otool` script

- It returns structured, provenance-bearing evidence rather than terminal text.
- It pages large symbol sets and records limitations.
- It keeps the research reproducible and reviewable.
- It can be called by an agent through MCP, so the evidence is captured in the same workflow as
  the documentation.

For a one-off dependency check, `otool -L` is fine. For a claim that will justify an architecture
decision, REA's evidence format is a better artifact.
