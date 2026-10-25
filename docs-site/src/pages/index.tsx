import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import type { ReactNode } from "react";
import styles from "./index.module.css";

const options = [
  {
    title: "Native port",
    status: "Not viable",
    body: "Reimplementing CoreSimulator, Mach/XPC, launchd_sim, Metal and IOSurface on Linux is a multi-year systems project, not a packaging exercise.",
    to: "/docs/research/architecture-options#option-a-native-darwin-compatibility-layer",
  },
  {
    title: "macOS VM on Linux",
    status: "Blocked",
    body: "QEMU's vmapple model targets Apple Silicon hosts and macOS guests, and Apple's licence restricts macOS virtualisation to Apple hardware.",
    to: "/docs/research/architecture-options#option-b-macos-vm-on-arm64-linux",
  },
  {
    title: "Remote Mac bridge",
    status: "Recommended",
    body: "Keep the simulator where Apple supports it. Stream pixels to Linux and send taps back over an authenticated HTTP/WebSocket protocol.",
    to: "/docs/research/architecture-options#option-c-remote-mac-bridge-recommended",
  },
];

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title="iOS Simulator on Linux, without fantasy" description={siteConfig.tagline}>
      <header className={styles.hero}>
        <div className="container">
          <p className={styles.eyebrow}>Research · Architecture · Reference implementation</p>
          <h1 className={styles.title}>
            The iOS Simulator cannot run on Linux. Your Linux workflow still can.
          </h1>
          <p className={styles.lead}>
            An evidence-based feasibility study, an execution plan, and a working remote-simulator
            bridge with a Linux CLI and browser viewer. No undocumented kernel emulation required.
          </p>
          <div className={styles.actions}>
            <Link className="button button--primary button--lg" to="/docs/intro">
              Read the findings
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/guides/quickstart">
              Quickstart
            </Link>
          </div>
        </div>
      </header>
      <main className="container">
        <section className={styles.grid}>
          {options.map((option) => (
            <Link className={styles.card} key={option.title} to={option.to}>
              <span className={styles.status}>{option.status}</span>
              <h2>{option.title}</h2>
              <p>{option.body}</p>
            </Link>
          ))}
        </section>
        <section className={styles.banner}>
          <div>
            <h2>What this repository ships</h2>
            <p>
              A macOS host daemon over <code>simctl</code> and <code>idb</code>, a Linux-friendly
              CLI, a browser viewer, contract tests, a Docker/OrbStack Linux smoke test, and
              Docusaurus documentation with the analysis plan, findings, ADRs and execution plan.
            </p>
          </div>
          <pre>
            <code>{`# on the Mac
npm run dev:host

# on Linux
ios-sim connect http://mac.local:7777 --token …
ios-sim devices
ios-sim open`}</code>
          </pre>
        </section>
      </main>
    </Layout>
  );
}
