// Fixtures from packages/codecommit-web/test/pr-requirement-dialogs-view.test.ts.
import { PRRequirementDialogsView } from "@knpkv/codecommit-web-design-system"
import { dialogState } from "../fixtures/pull-requests.js"

/** Granted CLI requirement with the tested reminder opt-out selected. */
export const GrantedRequired = () => <div style={{ transform: "translateZ(0)", height: 480 }}><PRRequirementDialogsView granted={{ ...dialogState, visible: true, dontRemind: true }} docker={dialogState} /></div>
/** Docker requirement before a sandbox can open. */
export const DockerRequired = () => <div style={{ transform: "translateZ(0)", height: 480 }}><PRRequirementDialogsView granted={dialogState} docker={{ ...dialogState, visible: true }} /></div>
