import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"

export default defineConfig({
  integrations: [
    starlight({
      title: "@knpkv",
      sidebar: [
        { label: "Guide", link: "/guide/" },
        { label: "Conventions", link: "/conventions/" },
        { label: "Jira", link: "/jira/" },
        { label: "Confluence", link: "/confluence/" },
        { label: "CodeCommit", link: "/codecommit/" },
        { label: "Jira Clockify", link: "/jira-clockify/" },
        { label: "Agent Skills", link: "/agent-skills/" },
        { label: "Migration", link: "/migration/" },
        { label: "Packages", link: "/packages/" }
      ]
    })
  ]
})
