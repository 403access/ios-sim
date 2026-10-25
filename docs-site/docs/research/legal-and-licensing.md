---

title: Legal and licensing
sidebar_position: 6
description: The non-technical constraints that shape what this project may ship and host.
---

# Legal and licensing

:::warning Not legal advice
This page records engineering constraints and questions for counsel. It is not a legal opinion.
Licence terms change and depend on jurisdiction, contract, and how a service is operated. Have
counsel review any multi-user or commercial deployment.
:::

## 1. What this repository ships

This repository contains **no Apple binaries, SDKs, simulator runtimes, or firmware**. It ships:

- Original source code (MIT).
- Documentation and test fixtures written for this project.
- A build script that creates a tiny test `.app` using the Xcode installation on the host.
- Commands that invoke Apple's tools (`xcrun simctl`, `idb`) already installed on a Mac.

The host daemon and CLI do not bypass code signing, the App Store, or Apple's device security.
They automate tools Apple ships for simulator development.

## 2. Apple software terms

The following categories are distinct and should not be conflated:

| Item                         | Where it comes from         | Practical constraint                                              |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------- |
| macOS                        | Apple                       | Licensed for Apple-branded hardware; virtualisation is restricted |
| Xcode and command-line tools | Apple Developer / App Store | Subject to the Xcode licence; not redistributable                 |
| iOS Simulator runtimes       | Xcode components            | Downloaded by Xcode; not redistributable as standalone files      |
| Simulator SDKs               | Xcode                       | Development use under the Xcode/SDK licence                       |
| App Store apps               | Apple / developers          | Do not use this project to run apps you are not authorised to use |
| `idb`                        | Meta, MIT                   | Permissive open source; still relies on Apple private frameworks  |

**Implication for the bridge:** the Mac host must have its own licensed macOS + Xcode
installation. The Linux client receives pixels and API responses, not Apple binaries. The runtime
stays on the licensed host.

## 3. Hosting and remote access

Running a Mac that other people access remotely raises questions that a local install does not:

1. **Who is the licensed user?** A shared Mac still needs valid macOS/Xcode licences.
2. **Does the service constitute redistribution?** Streaming pixels is not shipping the runtime,
   but the answer can depend on contract and jurisdiction.
3. **Are apps and data isolated?** Multiple users sharing one simulator can see each other's
   data. v0.1 is explicitly single-user/small-team; do not treat it as a multi-tenant service.
4. **Where does the data live?** Simulator data may include personal or regulated data. Apply
   retention and access controls.
5. **Is the network trusted?** Use a token and an SSH tunnel or TLS; do not expose an
   unauthenticated daemon to the internet.
6. **Are you using it for security research?** Authorisation, disclosure, and computer-misuse law
   apply independently of the simulator licence.

If you operate a shared host, get written guidance on the Apple licence terms that apply to your
organisation and deployment model.

## 4. macOS virtualisation

Apple's macOS licence permits virtualisation only under specific conditions and on Apple-branded
hardware. This is why [Option B](../research/architecture-options.md#option-b-macos-vm-on-arm64-linux)
is marked as legally blocked in addition to being technically unsupported. Downloading macOS
images from third-party sites or running macOS on non-Apple hardware is not an acceptable basis
for this project.

## 5. Reverse engineering and interoperability

The project uses [REA](https://github.com/morluto/rea) to inspect **binaries already installed on
the Mac** for interoperability research: dependencies, imports, and architecture. It does not:

- Extract or redistribute Apple code.
- Circumvent code signing, DRM, or device activation.
- Provide decryption keys or jailbreak functionality.
- Encourage use against systems you do not own or are not authorised to test.

Reverse-engineering law varies by jurisdiction (for example, interoperability exceptions in the
EU and the DMCA's security-research exemptions in the US). If you plan to publish findings or
build a compatibility layer, involve counsel early.

## 6. Third-party licences

| Dependency                                                | Licence                | Notes                                         |
| --------------------------------------------------------- | ---------------------- | --------------------------------------------- |
| Node.js, TypeScript, Fastify, Zod, Commander, `ws`, `tar` | MIT / ISC / Apache-2.0 | Permissive; keep notices                      |
| `idb` / `idb_companion`                                   | MIT                    | Optional host dependency, not bundled         |
| Docusaurus, React                                         | MIT                    | Documentation site only                       |
| REA                                                       | MIT                    | Development tooling, not a runtime dependency |
| Apple frameworks                                          | Proprietary            | Not redistributed; used on the licensed host  |

Run `npm ls --all` and your organisation's licence scanner before distributing binaries.

## 7. Security and privacy obligations

Even a single-user bridge can expose sensitive material:

- Screenshots may contain tokens, messages, or personal data.
- Logs may contain identifiers and network addresses.
- Uploaded `.app` bundles may contain secrets in resources or `Info.plist`.
- Tokens in URLs may appear in browser history, proxy logs, or shell history.

Mitigations are documented in the [threat model](../security/threat-model.md). The defaults are
loopback binding and token authentication; the operator is responsible for transport security and
data handling.

## 8. Export and sanctions

Cryptography and software distribution can be subject to export controls. The project uses
standard TLS/HTTP libraries and does not implement custom cryptography. If you distribute binaries
internationally, use the same compliance process as for other developer tools.

## 9. Checklist before sharing a host

- [ ] Mac is owned/licensed by the organisation; macOS and Xcode terms are understood.
- [ ] Simulator runtime was installed by Xcode, not copied from a third party.
- [ ] Only authorised apps are installed and tested.
- [ ] Host is bound to loopback or a private network; token is enabled.
- [ ] SSH tunnel or TLS is used for remote access; no public unauthenticated port.
- [ ] Users know the host is shared and simulator data is not tenant-isolated.
- [ ] Logs/screenshots have a retention policy.
- [ ] `idb` and other dependencies are reviewed and pinned.
- [ ] Legal review is complete for multi-user or commercial operation.
- [ ] Incident contact and shutdown procedure are documented.

## 10. Licence of this project

Original code and documentation in this repository are released under the MIT licence. Apple
trademarks and framework names belong to Apple. The project is not affiliated with or endorsed by
Apple. See `LICENSE` in the repository.
