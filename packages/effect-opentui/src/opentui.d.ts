/**
 * Type augmentation for @opentui/core exports.
 *
 * This file provides explicit type declarations for @opentui/core types
 * that TypeScript has trouble resolving through the export * chain.
 */

declare module "@opentui/core" {
  import { EventEmitter } from "events"

  // === Configuration ===
  export interface CliRendererConfig {
    stdin?: NodeJS.ReadStream
    stdout?: NodeJS.WriteStream
    exitOnCtrlC?: boolean
    exitSignals?: Array<NodeJS.Signals>
    debounceDelay?: number
    targetFps?: number
    maxFps?: number
    useThread?: boolean
    useAlternateScreen?: boolean
    useMouse?: boolean
    backgroundColor?: string
    onDestroy?: () => void
  }

  // === Key Events ===
  export type KeyEventType = "press" | "release"

  export class KeyEvent {
    name: string
    ctrl: boolean
    meta: boolean
    shift: boolean
    option: boolean
    sequence: string
    number: boolean
    raw: string
    eventType: KeyEventType
    source: "raw" | "kitty"
    code?: string
    super?: boolean
    hyper?: boolean
    capsLock?: boolean
    numLock?: boolean
    baseCode?: number
    repeated?: boolean
    get defaultPrevented(): boolean
    preventDefault(): void
  }

  export type KeyHandlerEventMap = {
    keypress: [KeyEvent]
    keyrelease: [KeyEvent]
    paste: [{ text: string }]
  }

  export class KeyHandler extends EventEmitter<KeyHandlerEventMap> {
    processInput(data: string): boolean
    on<K extends keyof KeyHandlerEventMap>(event: K, listener: (...args: KeyHandlerEventMap[K]) => void): this
    off<K extends keyof KeyHandlerEventMap>(event: K, listener: (...args: KeyHandlerEventMap[K]) => void): this
  }

  // === Base Renderables ===
  export interface RenderContext {
    root: RootRenderable
  }

  export interface RenderableOptions<_T = Renderable> {
    id?: string
    x?: number
    y?: number
    width?: number | string
    height?: number | string
    flexDirection?: "row" | "column"
    flexGrow?: number
    flexShrink?: number
    alignItems?: "flex-start" | "flex-end" | "center" | "stretch"
    justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "space-around"
    padding?: number
    margin?: number
    onKey?: (key: KeyEvent) => void
    onClick?: (event: unknown) => void
    [key: string]: unknown
  }

  export abstract class Renderable extends EventEmitter {
    id: string
    x: number
    y: number
    width: number
    height: number
    focused: boolean
    destroyed: boolean
    parent: Renderable | null
    children: Array<Renderable>

    add(child: Renderable, index?: number): void
    remove(child: Renderable): void
    clear(): void
    destroy(): void
    focus(): void
    blur(): void
    requestRender(): void
    set(options: Partial<RenderableOptions>): void
  }

  export class RootRenderable extends Renderable {
    constructor(ctx: RenderContext)
  }

  // === Box ===
  export interface BoxOptions extends RenderableOptions<BoxRenderable> {
    backgroundColor?: string
    borderStyle?: "single" | "double" | "rounded"
    border?: boolean
    borderColor?: string
    shouldFill?: boolean
    title?: string
    titleAlignment?: "left" | "center" | "right"
    gap?: number | string
  }

  export class BoxRenderable extends Renderable {
    constructor(ctx: RenderContext, options?: BoxOptions)
    set backgroundColor(value: string)
    set border(value: boolean)
    set borderStyle(value: "single" | "double" | "rounded")
    set title(value: string | undefined)
  }

  // === Text ===
  export interface TextOptions extends RenderableOptions<TextRenderable> {
    content?: string
  }

  export class TextRenderable extends Renderable {
    constructor(ctx: RenderContext, options?: TextOptions)
    set content(value: string)
    get content(): string
  }

  // === Select ===
  export interface SelectOption {
    name: string
    description: string
    value?: unknown
  }

  export interface SelectRenderableOptions extends RenderableOptions<SelectRenderable> {
    backgroundColor?: string
    textColor?: string
    focusedBackgroundColor?: string
    focusedTextColor?: string
    options?: Array<SelectOption>
    selectedIndex?: number
    selectedBackgroundColor?: string
    selectedTextColor?: string
    descriptionColor?: string
    showScrollIndicator?: boolean
    wrapSelection?: boolean
    showDescription?: boolean
    itemSpacing?: number
  }

  export enum SelectRenderableEvents {
    SELECTION_CHANGED = "selectionChanged",
    ITEM_SELECTED = "itemSelected"
  }

  export class SelectRenderable extends Renderable {
    constructor(ctx: RenderContext, options?: SelectRenderableOptions)
    get selectedIndex(): number
    set selectedIndex(value: number)
    get options(): Array<SelectOption>
    set options(value: Array<SelectOption>)
    moveUp(): void
    moveDown(): void
  }

  // === ScrollBox ===
  export interface ScrollBoxOptions extends BoxOptions {
    scrollX?: boolean
    scrollY?: boolean
    stickyScroll?: boolean
  }

  export class ScrollBoxRenderable extends BoxRenderable {
    constructor(ctx: RenderContext, options?: ScrollBoxOptions)
    readonly content: BoxRenderable
    scrollToTop(): void
    scrollToBottom(): void
    scrollBy(x: number, y: number): void
  }

  // === CliRenderer ===
  export class CliRenderer extends EventEmitter implements RenderContext {
    root: RootRenderable
    keyInput: KeyHandler

    constructor(config?: CliRendererConfig)
    start(): void
    stop(): void
    destroy(): void
    requestRender(): void
  }

  export function createCliRenderer(config?: CliRendererConfig): Promise<CliRenderer>
}
