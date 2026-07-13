import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"

export default defineConfig({
  integrations: [
    starlight({
      title: "@knpkv",
      sidebar: [
        {
          label: "Start Here",
          items: [
            { label: "Overview", link: "/" },
            { label: "Guide", link: "/guide/" },
            { label: "Conventions", link: "/conventions/" },
            { label: "Migration", link: "/migration/" },
            { label: "Atlassian Profiles", link: "/atlassian-profiles/" }
          ]
        },
        {
          label: "Product CLIs",
          items: [
            { label: "Jira", link: "/jira/" },
            { label: "Confluence", link: "/confluence/" },
            { label: "CodeCommit", link: "/codecommit/" },
            { label: "Jira Clockify", link: "/jira-clockify/" }
          ]
        },
        {
          label: "Libraries",
          items: [
            { label: "rly Design System", link: "/rly/" },
            { label: "Packages", link: "/packages/" },
            { label: "Agent Skills", link: "/agent-skills/" }
          ]
        }
      ]
    })
  ]
})
