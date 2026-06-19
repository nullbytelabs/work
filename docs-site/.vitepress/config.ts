import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// Served from GitHub Pages at https://nullbytelabs.github.io/work/
// so every absolute asset/link is prefixed with the repo name.
const base = "/work/";

// withMermaid wraps the config so ```mermaid fences render as diagrams
// (e.g. the live `work graph ci` output on the dogfooding page).
export default withMermaid(defineConfig({
  base,
  lang: "en-US",
  title: "work",
  description:
    "Run durable, sandboxed workflows on your own machine — each job isolated in a secure micro-VM, with AI agents as first-class steps.",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  appearance: "dark", // dark by default for everyone; toggle still available

  head: [
    ["link", { rel: "icon", href: `${base}favicon.svg` }],
    ["meta", { name: "theme-color", content: "#c0421d" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "work" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Durable, sandboxed workflows on your own machine — each job in a secure micro-VM, with AI agents as first-class steps.",
      },
    ],
  ],

  themeConfig: {
    logo: { light: "/logo.svg", dark: "/logo-dark.svg" },

    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Examples", link: "/examples/dogfooding", activeMatch: "/examples/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "/reference/" },
      {
        text: "v0.3.3",
        items: [
          {
            text: "Changelog",
            link: "https://github.com/nullbytelabs/work/releases",
          },
          {
            text: "npm",
            link: "https://www.npmjs.com/package/@nullbytelabs/work",
          },
        ],
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Requirements", link: "/guide/requirements" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Quickstart", link: "/guide/quickstart" },
          ],
        },
        {
          text: "Workflows",
          items: [
            { text: "Writing a workflow", link: "/guide/writing-workflows" },
            { text: "Reusable workflows", link: "/guide/reusable-workflows" },
            { text: "Project layout", link: "/guide/project-layout" },
            { text: "Custom images", link: "/guide/custom-images" },
            { text: "Agent steps (AI)", link: "/guide/agent-steps" },
            { text: "Actions", link: "/guide/actions" },
            { text: "Composite actions", link: "/guide/composite-actions" },
            { text: "Built-in actions", link: "/guide/builtin-actions" },
            { text: "The serve host", link: "/guide/web-ui" },
            { text: "Observability", link: "/guide/observability" },
          ],
        },
        {
          text: "Under the hood",
          items: [{ text: "How it works", link: "/guide/how-it-works" }],
        },
      ],
      "/examples/": [
        {
          text: "Real-world examples",
          items: [
            { text: "Dogfooding: the engine checks itself", link: "/examples/dogfooding" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI", link: "/reference/cli" },
            { text: "Workflow syntax", link: "/reference/workflow-syntax" },
            { text: "Configuration", link: "/reference/configuration" },
          ],
        },
      ],
    },

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/nullbytelabs/work",
      },
    ],

    editLink: {
      pattern:
        "https://github.com/nullbytelabs/work/edit/main/docs-site/:path",
      text: "Edit this page on GitHub",
    },

    search: {
      provider: "local",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 nullbytelabs",
    },

    outline: { level: [2, 3] },
  },
}));
