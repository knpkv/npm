/**
 * Chromium launch arguments for a touch-first device: a coarse primary pointer (Blink pointer type
 * 2) that cannot hover (Blink hover type 1), so both `(pointer: coarse)` and `(hover: none)` match.
 * CDP media emulation does not reach `matchMedia`, so the browser itself must report the device.
 * Shared by the coarse visual project and the touch Storybook play project.
 */
export const COARSE_POINTER_LAUNCH_ARGS: ReadonlyArray<string> = [
  "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1"
]
