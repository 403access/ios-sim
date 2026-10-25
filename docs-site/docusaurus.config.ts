import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

const config: Config = {
  title: "iOS Sim Bridge",
  tagline: "Control a real iOS Simulator from any Linux machine",
  favicon: "img/logo.svg",
  url: "https://403access.github.io",
  baseUrl: "/ios-sim/",
  organizationName: "403access",
  projectName: "ios-sim",
  onBrokenLinks: "throw",
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },
  themes: ["@docusaurus/theme-mermaid"],
  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/403access/ios-sim/tree/main/docs-site/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    image: "img/social-card.svg",
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "iOS Sim Bridge",
      logo: {
        alt: "iOS Sim Bridge",
        src: "img/logo.svg",
      },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Documentation" },
        {
          href: "https://github.com/403access/ios-sim",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Overview", to: "/docs/intro" },
            { label: "Research", to: "/docs/research/analysis-plan" },
            { label: "Execution plan", to: "/docs/plans/execution-plan" },
          ],
        },
        {
          title: "Project",
          items: [
            { label: "GitHub", href: "https://github.com/403access/ios-sim" },
            { label: "REA", href: "https://github.com/morluto/rea" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} 403access. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "swift"],
    },
    mermaid: {
      theme: { light: "neutral", dark: "dark" },
    },
  } satisfies Config["themeConfig"],
};

export default config;
