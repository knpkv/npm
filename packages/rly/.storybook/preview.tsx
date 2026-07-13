import type { Decorator, Preview } from "@storybook/react-vite"
import { MINIMAL_VIEWPORTS } from "storybook/viewport"
import { CatalogEnvironment, resolveCatalogEnvironment } from "./catalog-environment.js"

const withCatalogEnvironment: Decorator = (Story, context) => {
  const values = resolveCatalogEnvironment(context.globals)

  return (
    <CatalogEnvironment values={values}>
      <Story />
    </CatalogEnvironment>
  )
}

const preview = {
  decorators: [withCatalogEnvironment],
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: {
        dynamicTitle: true,
        items: [
          { title: "System", value: "system" },
          { title: "Light", value: "light" },
          { title: "Dark", value: "dark" }
        ],
        title: "Theme"
      }
    },
    forcedColors: {
      description: "Forced-colors simulation",
      toolbar: {
        dynamicTitle: true,
        items: [
          { title: "Automatic", value: "auto" },
          { title: "Active", value: "active" }
        ],
        title: "Forced colors"
      }
    },
    reducedMotion: {
      description: "Motion preference",
      toolbar: {
        dynamicTitle: true,
        items: [
          { title: "System", value: "system" },
          { title: "Reduce", value: "reduce" },
          { title: "No preference", value: "no-preference" }
        ],
        title: "Motion"
      }
    },
    locale: {
      description: "Catalog locale",
      toolbar: {
        dynamicTitle: true,
        items: [
          { title: "English", value: "en" },
          { title: "Nederlands", value: "nl" }
        ],
        title: "Locale"
      }
    },
    density: {
      description: "Interface density",
      toolbar: {
        dynamicTitle: true,
        items: [
          { title: "Comfortable", value: "comfortable" },
          { title: "Compact", value: "compact" }
        ],
        title: "Density"
      }
    }
  },
  initialGlobals: {
    density: "comfortable",
    forcedColors: "auto",
    locale: "en",
    reducedMotion: "system",
    theme: "system",
    viewport: { isRotated: false, value: "desktop" }
  },
  parameters: {
    a11y: {
      test: "error"
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    docs: {
      toc: true
    },
    viewport: {
      options: MINIMAL_VIEWPORTS
    }
  }
} satisfies Preview

export default preview
