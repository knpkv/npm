import { Context, Layer, Effect } from "effect";

export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<any>;
    readonly save: (config: any) => Effect.Effect<void>;
    readonly detectProfiles: Effect.Effect<any[]>;
  }
>() {}

export const ConfigServiceLive = Layer.succeed(ConfigService, ConfigService.of({
    load: Effect.succeed({ accounts: [] }),
    save: () => Effect.void,
    detectProfiles: Effect.succeed([])
}));
