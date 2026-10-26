import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    {
      type: "category",
      label: "Research",
      collapsed: false,
      items: [
        "research/analysis-plan",
        "research/findings",
        "research/architecture-options",
        "research/prior-art",
        "research/feasibility-matrix",
        "research/legal-and-licensing",
        "research/references",
      ],
    },
    {
      type: "category",
      label: "Native track (Option A)",
      collapsed: false,
      items: ["native/overview", "native/architecture", "native/abi", "native/limitations"],
    },
    {
      type: "category",
      label: "Roadmaps",
      collapsed: false,
      items: [
        "roadmaps/index",
        "plans/roadmap",
        "native/roadmap",
        "roadmaps/native/technical",
        "roadmaps/native/backlog",
        "roadmaps/bridge/backlog",
        "roadmaps/engineering-quality",
        "roadmaps/research-legal",
      ],
    },
    {
      type: "category",
      label: "Plans",
      collapsed: false,
      items: ["plans/execution-plan", "plans/testing-strategy"],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        "guides/quickstart",
        "guides/host-setup",
        "guides/linux-client",
        "guides/browser-viewer",
        "guides/troubleshooting",
        "guides/rea",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: [
        "reference/architecture",
        "reference/api",
        "reference/cli",
        "reference/protocol",
        "security/threat-model",
      ],
    },
    {
      type: "category",
      label: "Decisions",
      items: [
        "adr/remote-mac-bridge",
        "adr/typescript-bun",
        "adr/simctl-and-idb",
        "adr/jpeg-websocket-stream",
        "adr/token-auth",
        "adr/native-research-track",
        "adr/native-kernel-boundary",
      ],
    },
  ],
};

export default sidebars;
