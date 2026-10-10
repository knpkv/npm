// Fixtures from packages/herdr-connect/test/creature.test.tsx.
import { Creature } from "@knpkv/relay-app-design-system"

export const Default = () => <Creature host="nix" id="a1" size="stage" state="working" />
export const Waiting = () => <Creature arrived host="nix" id="a1" size="stage" state="waiting" />
export const NeedsAttention = () => <Creature host="nix" id="a1" size="stage" state="blocked" />
export const Done = () => <Creature host="nix" id="a1" size="stage" state="done" />
export const Stale = () => <Creature host="nix" id="a1" size="stage" stale state="working" />
