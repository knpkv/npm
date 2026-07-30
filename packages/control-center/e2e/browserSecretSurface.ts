import type { Page } from "@playwright/test"

/** Browser-owned text surfaces that must never reveal an HttpOnly session secret. */
export interface BrowserSecretSurface {
  readonly cacheStorage: string
  readonly documentHtml: string
  readonly indexedDb: string
  readonly liveFormControlValues: string
  readonly localStorage: string
  readonly openShadowRootContent: string
  readonly readableCookies: string
  readonly sessionStorage: string
  readonly url: string
}

export interface BrowserForbiddenValue {
  readonly label: string
  readonly value: string
}

export interface BrowserContextCookie {
  readonly domain: string
  readonly httpOnly: boolean
  readonly name: string
  readonly path: string
  readonly value: string
}

/** Serialize every JavaScript-readable context cookie, retaining its path scope. */
export const serializeBrowserReadableCookies = (
  cookies: ReadonlyArray<BrowserContextCookie>
): string =>
  JSON.stringify(
    cookies
      .filter(({ httpOnly }) => !httpOnly)
      .map(({ domain, name, path, value }) => ({ domain, name, path, value }))
  )

/** Snapshot text reachable through same-origin browser APIs, including durable browser databases and caches. */
export const snapshotBrowserReadableSurface = async (
  page: Page,
  cookies: ReadonlyArray<BrowserContextCookie>
): Promise<BrowserSecretSurface> => {
  const pageSurface = await page.evaluate<Omit<BrowserSecretSurface, "readableCookies">>(`(async () => {
    const serializeCloneValue = (value) => {
      try {
        return JSON.stringify(value) ?? Object.prototype.toString.call(value);
      } catch {
        return "[nonserializable structured clone]";
      }
    };
    const requestResult = async (request) => await new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });

    const indexedDbContent = [];
    for (const databaseInfo of await indexedDB.databases()) {
      if (databaseInfo.name === undefined) continue;
      const database = await requestResult(indexedDB.open(databaseInfo.name));
      try {
        for (const storeName of database.objectStoreNames) {
          const store = database.transaction(storeName, "readonly").objectStore(storeName);
          const [keys, values] = await Promise.all([
            requestResult(store.getAllKeys()),
            requestResult(store.getAll())
          ]);
          indexedDbContent.push({
            database: databaseInfo.name,
            records: keys.map((key, index) => ({
              key: serializeCloneValue(key),
              value: serializeCloneValue(values[index])
            })),
            store: storeName
          });
        }
      } finally {
        database.close();
      }
    }

    const cacheStorageContent = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        if (new URL(request.url).origin !== location.origin) continue;
        const response = await cache.match(request);
        if (response === undefined || response.type === "opaque") continue;
        cacheStorageContent.push({
          body: await response.clone().text(),
          cache: cacheName,
          method: request.method,
          url: request.url
        });
      }
    }

    const liveFormControlValues = [];
    const openShadowRootContent = [];
    const visitRoot = (root) => {
      for (const control of root.querySelectorAll("input, textarea, select")) {
        liveFormControlValues.push(control.value);
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot !== null) {
          openShadowRootContent.push({
            html: element.shadowRoot.innerHTML,
            text: element.shadowRoot.textContent
          });
          visitRoot(element.shadowRoot);
        }
      }
    };
    visitRoot(document);

    return {
      cacheStorage: JSON.stringify(cacheStorageContent),
      documentHtml: document.documentElement.outerHTML,
      indexedDb: JSON.stringify(indexedDbContent),
      liveFormControlValues: JSON.stringify(liveFormControlValues),
      localStorage: JSON.stringify(Object.entries(localStorage)),
      openShadowRootContent: JSON.stringify(openShadowRootContent),
      sessionStorage: JSON.stringify(Object.entries(sessionStorage)),
      url: location.href
    };
  })()`)

  return {
    ...pageSurface,
    readableCookies: serializeBrowserReadableCookies(cookies)
  }
}

/** Detect a value in any browser-readable surface without assuming a storage key. */
export const browserSurfaceExposesSecret = (surface: BrowserSecretSurface, secret: string): boolean =>
  Object.values(surface).some((value) => value.includes(secret))

/** Return labels only, so a failed assertion never prints the forbidden values themselves. */
export const exposedBrowserForbiddenValues = (
  surface: BrowserSecretSurface,
  forbiddenValues: ReadonlyArray<BrowserForbiddenValue>
): ReadonlyArray<string> =>
  forbiddenValues
    .filter(({ value }) => browserSurfaceExposesSecret(surface, value))
    .map(({ label }) => label)
