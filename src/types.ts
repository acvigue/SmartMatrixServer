export interface SpriteConfig {
  name: string
  duration: number
  external?: boolean
  config: Record<string, any>
  is_skipped: boolean
  is_pinned: boolean
}

export interface Device {
  schedule: SpriteConfig[]
  currentlyUpdatingSprite: number
}
