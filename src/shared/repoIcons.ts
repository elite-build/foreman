// Lucide icons for repositories (Lucide's PascalCase names): the picker shows the popular ones before a search, and
// Foreman suggests one of the whole list for a repository that has no icon of its own (main/repoIcons.ts).

export const POPULAR_REPO_ICONS: readonly string[] = [
  'Code', 'Terminal', 'Globe', 'Rocket', 'Package', 'Box', 'Database', 'Server', 'Cloud', 'Cpu', 'Smartphone', 'Monitor',
  'Laptop', 'BookOpen', 'FileCode', 'Folder', 'GitBranch', 'Zap', 'Flame', 'Leaf', 'Star', 'Heart', 'Coffee', 'Puzzle',
  'Layers', 'Shield', 'Lock', 'Bot', 'Brain', 'Gamepad2', 'EighthNote', 'Camera', 'Image', 'Palette', 'Wrench', 'Cog',
  'Atom', 'Sparkles', 'Store', 'ShoppingCart', 'Wallet', 'ChartLine', 'Map', 'Compass', 'Mail', 'MessageSquare',
  'Calendar', 'Users', 'House', 'Truck', 'Plane', 'Anchor', 'Feather', 'PenTool', 'Blocks', 'Container', 'Webhook',
  'Workflow', 'Braces', 'FlaskConical'
]

// More subjects than a programmer's tools, for notes, writing and personal repositories.
export const SUGGESTED_REPO_ICONS: readonly string[] = [
  ...POPULAR_REPO_ICONS,
  'User', 'Briefcase', 'GraduationCap', 'Notebook', 'Newspaper', 'Megaphone', 'Film', 'Dumbbell', 'Stethoscope', 'Landmark',
  'Lightbulb', 'Target', 'Trophy', 'Library', 'Bug', 'Gauge', 'Search', 'Mic', 'Headphones', 'Utensils', 'Sprout', 'Scale',
  'Hammer', 'Microscope', 'Mountain', 'Gift', 'PiggyBank', 'Receipt', 'Languages', 'Telescope', 'Dna', 'Paintbrush', 'Key',
  'Network', 'Keyboard', 'Bell', 'Send', 'Video', 'Calculator', 'Bookmark'
]
