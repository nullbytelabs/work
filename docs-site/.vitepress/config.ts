import { defineConfig } from "vitepress";

// Served from GitHub Pages at https://nullbytelabs.github.io/pi-workflows/,
// so every absolute asset/link is prefixed with the repo name.
const base = "/pi-workflows/";

export default defineConfig({
  base,
  lang: "en-US",
  title: "pi-workflows",
  description:
    "Run durable, sandboxed workflows on your own machine — each job isolated in a secure micro-VM, with AI agents as first-class steps.",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,

  head: [
    ["link", { rel: "icon", href: `${base}favicon.svg` }],
    ["meta", { name: "theme-color", content: "#646cff" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "pi-workflows" }],
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
    logo: "/logo.svg",

    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "/reference/" },
      {
        text: "v0.1.2",
        items: [
          {
            text: "Changelog",
            link: "https://github.com/nullbytelabs/pi-workflows/releases",
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
            { text: "Agent steps (AI)", link: "/guide/agent-steps" },
            { text: "Actions & work/agent", link: "/guide/actions" },
            { text: "Web console", link: "/guide/web-ui" },
          ],
        },
        {
          text: "Under the hood",
          items: [{ text: "How it works", link: "/guide/how-it-works" }],
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
        link: "https://github.com/nullbytelabs/pi-workflows",
      },
    ],

    editLink: {
      pattern:
        "https://github.com/nullbytelabs/pi-workflows/edit/main/docs-site/:path",
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
});
