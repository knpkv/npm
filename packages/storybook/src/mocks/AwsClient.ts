import { Context, Layer, Effect } from "effect";

export class AwsClient extends Context.Tag("AwsClient")<
  AwsClient,
  {
    readonly getCallerIdentity: (args: any) => Effect.Effect<string>;
    readonly getOpenPullRequests: (args: any) => any; // Return stream or effect
  }
>() {}

export const AwsClientLive = Layer.succeed(AwsClient, AwsClient.of({
    getCallerIdentity: () => Effect.succeed("mock-user"),
    getOpenPullRequests: () => Effect.succeed([]) // or stream
}));
